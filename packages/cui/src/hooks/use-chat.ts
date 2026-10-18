import { useState, useRef, useCallback } from "react"
import { readChatEvents } from "../lib/chat-events"
import { sumSessionTokens } from "../lib/token-usage"
import prettyMs from "pretty-ms"
import type { ClientResponse } from "hono/client"
import { appClient } from "../lib/api-client"
import { getErrorMessage } from "../lib/http-errors"
import type { Mode } from "@myagent/database"
import { type ChatStreamEvent, type MessagePart, type SupportedChatModelId } from "@myagent/shared"

export type ClientMessagePart =
  | { type: "tool-limit-warning"; limit: number }
  | { type: "reasoning"; text: string }
  | ClientToolCallPart
  | { type: "text"; text: string }

const UNKNOWN_TOOL_RESULT = "[Chamada interrompida: resultado não registrado. Inspecione o estado; não repita automaticamente efeitos colaterais.]"

export function clientMessageParts(parts: MessagePart[]): ClientMessagePart[] {
  const result: ClientMessagePart[] = []
  for (const part of parts) {
    if (part.type === "tool-result") {
      const call = result.find((item): item is ClientToolCallPart => item.type === "tool-call" && item.id === part.id)
      if (call) { call.result = part.result; call.status = "done" }
    } else if (part.type === "tool-call") result.push({ ...part, result: UNKNOWN_TOOL_RESULT, status: "done" })
    else result.push(part)
  }
  return result
}

export type ClientToolCallPart = {
  type: "tool-call"
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  status: "calling" | "done"
}

export type Message = { totalTokens?: number } & (
  | { id: string; role: "user"; content: string; mode: Mode; model: SupportedChatModelId }
  | { id: string; role: "assistant"; content: string; mode: Mode; model: SupportedChatModelId; parts: ClientMessagePart[]; duration?: string; interrupted?: boolean }
  | { id: string; role: "error"; content: string })

type StreamingState =
  | { status: "idle" }
  | { status: "streaming"; parts: ClientMessagePart[]; mode: Mode; model: SupportedChatModelId; totalTokens: number }

type ActiveStream = {
  requestId: string
  messageId?: string
  controller: AbortController
  mode: Mode
  model: SupportedChatModelId
  parts: ClientMessagePart[]
  interruptedCaptured: boolean
  totalTokens: number
}

type SubmitParams = { userText: string; mode: Mode; model: SupportedChatModelId }
type RunStreamParams = {
  mode: Mode
  model: SupportedChatModelId
  request: (controller: AbortController) => Promise<ClientResponse<unknown>>
}

export function useChat(sessionId: string, initialMessages: Message[], client = appClient) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [pendingApprovals, setPendingApprovals] = useState<Extract<ChatStreamEvent, { type: "approval-required" }>[]>([])
  const [streaming, setStreaming] = useState<StreamingState>({ status: "idle" })
  const [undoing, setUndoing] = useState(false)
  const undoingRef = useRef(false)
  const activeStreamRef = useRef<ActiveStream | null>(null)
  const [pendingResume, setPendingResume] = useState(() => {
    const last = initialMessages.at(-1)
    return last?.role === "user" || last?.role === "assistant" && last.interrupted ? last : null
  })

  const updateMessages = useCallback((updater: (prev: Message[]) => Message[]) => setMessages(updater), [])
  const isActiveRequest = useCallback((requestId: string) => activeStreamRef.current?.requestId === requestId, [])

  const emitParts = useCallback((requestId: string, parts: ClientMessagePart[]) => {
    if (!isActiveRequest(requestId)) return
    const activeStream = activeStreamRef.current
    if (!activeStream) return
    const snapshot = [...parts]
    activeStream.parts = snapshot
    setStreaming({ status: "streaming", parts: snapshot, mode: activeStream.mode, model: activeStream.model, totalTokens: activeStream.totalTokens })
  }, [isActiveRequest])

  const clearStream = useCallback((requestId: string) => {
    if (!isActiveRequest(requestId)) return
    activeStreamRef.current = null
    setPendingApprovals([])
    setStreaming({ status: "idle" })
  }, [isActiveRequest])

  const captureInterruptedMessage = useCallback((activeStream: ActiveStream) => {
    if (activeStream.interruptedCaptured || (!activeStream.messageId && activeStream.parts.length === 0 && activeStream.totalTokens === 0)) return
    activeStream.interruptedCaptured = true
    const parts = activeStream.parts.map(part => part.type === "tool-call" ? { ...part, result: part.result ?? UNKNOWN_TOOL_RESULT, status: "done" as const } : part)
    const content = parts.filter((part): part is Extract<ClientMessagePart, { type: "text" }> => part.type === "text").map((part) => part.text).join("")
    const message: Message = {
      id: activeStream.messageId ?? crypto.randomUUID(), role: "assistant", content,
      mode: activeStream.mode, model: activeStream.model, parts, interrupted: true,
      totalTokens: activeStream.totalTokens,
    }
    updateMessages(prev => [...prev, message])
    setPendingResume(message)
  }, [updateMessages])

  const handleStream = useCallback(async (response: ClientResponse<unknown>, activeStream: ActiveStream) => {
    if (!isActiveRequest(activeStream.requestId)) return
    if (!response.ok) {
      const content = await getErrorMessage(response)
      updateMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "error", content }])
      return
    }
    if (!response.body) {
      updateMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "error", content: "The server returned an empty response body." }])
      return
    }

    const parts: ClientMessagePart[] = []
    const stream = readChatEvents(response.body)

    for await (const event of stream) {
      if (!isActiveRequest(activeStream.requestId)) return

      switch (event.type) {
        case "generation-started":
          activeStream.messageId = event.messageId
          break
        case "tool-limit-warning":
          parts.push(event)
          emitParts(activeStream.requestId, parts)
          break
        case "usage":
          // O evento contém o acumulado da geração, não um delta.
          activeStream.totalTokens = event.totalTokens
          emitParts(activeStream.requestId, parts)
          break
        case "approval-required":
          setPendingApprovals(prev => [...prev, event])
          break
        case "reasoning-delta": {
          const last = parts.at(-1)
          if (last?.type === "reasoning") last.text += event.text
          else parts.push({ type: "reasoning", text: event.text })
          emitParts(activeStream.requestId, parts)
          break
        }
        case "tool-call":
          parts.push({ type: "tool-call", id: event.toolCallId, name: event.toolName, args: event.args, status: "calling" })
          emitParts(activeStream.requestId, parts)
          break
        case "tool-result": {
          const toolCall = parts.find((part): part is ClientToolCallPart => part.type === "tool-call" && part.id === event.toolCallId)
          if (toolCall) { toolCall.result = event.result; toolCall.status = "done" }
          emitParts(activeStream.requestId, parts)
          break
        }
        case "text-delta": {
          const last = parts.at(-1)
          if (last?.type === "text") last.text += event.text
          else parts.push({ type: "text", text: event.text })
          emitParts(activeStream.requestId, parts)
          break
        }
        case "done": {
          const content = parts.filter((part): part is Extract<ClientMessagePart, { type: "text" }> => part.type === "text").map((part) => part.text).join("")
          updateMessages((prev) => [...prev, {
            id: event.messageId, role: "assistant", content,
            mode: activeStream.mode, model: activeStream.model,
            duration: prettyMs(event.durationMs), parts: [...parts],
            totalTokens: activeStream.totalTokens,
          }])
          activeStream.interruptedCaptured = true
          setStreaming({ status: "idle" })
          return
        }
        case "error":
          if (event.messageId) {
            activeStream.messageId = event.messageId
            activeStream.parts = event.parts ? clientMessageParts(event.parts) : [...parts]
            captureInterruptedMessage(activeStream)
            setStreaming({ status: "idle" })
            return
          }
          activeStream.interruptedCaptured = true
          updateMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "error", content: event.message, totalTokens: activeStream.totalTokens }])
          setStreaming({ status: "idle" })
          return
      }
    }
  }, [emitParts, isActiveRequest, updateMessages, captureInterruptedMessage])

  const runStream = useCallback(async ({ mode, model, request }: RunStreamParams) => {
    const controller = new AbortController()
    const activeStream: ActiveStream = { requestId: crypto.randomUUID(), controller, mode, model, parts: [], interruptedCaptured: false, totalTokens: 0 }
    activeStreamRef.current = activeStream
    setStreaming({ status: "streaming", parts: [], mode, model, totalTokens: 0 })
    try {
      await handleStream(await request(controller), activeStream)
    } catch (error) {
      if (controller.signal.aborted) return
      if (isActiveRequest(activeStream.requestId)) {
        captureInterruptedMessage(activeStream)
        updateMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "error", content: error instanceof Error ? error.message : String(error), totalTokens: activeStream.interruptedCaptured ? 0 : activeStream.totalTokens }])
      }
    } finally {
      if (isActiveRequest(activeStream.requestId)) captureInterruptedMessage(activeStream)
      clearStream(activeStream.requestId)
    }
  }, [clearStream, handleStream, isActiveRequest, updateMessages, captureInterruptedMessage])

  const stopActiveStream = useCallback((capturePartial: boolean) => {
    const activeStream = activeStreamRef.current
    if (!activeStream) return
    if (capturePartial) captureInterruptedMessage(activeStream)
    activeStream.controller.abort()
    activeStreamRef.current = null
    setPendingApprovals([])
    setStreaming({ status: "idle" })
  }, [captureInterruptedMessage])

  const abort = useCallback(() => stopActiveStream(false), [stopActiveStream])
  const interrupt = useCallback(() => stopActiveStream(true), [stopActiveStream])

  const resume = useCallback(async ({ mode, model }: Omit<SubmitParams, "userText">) => {
    if (activeStreamRef.current || undoingRef.current) return
    setPendingResume(null)
    await runStream({ mode, model, request: (controller) => client.chat[":sessionId"].resume.$post(
      { param: { sessionId } }, { init: { signal: controller.signal } },
    ) })
  }, [client, runStream, sessionId])

  const undo = useCallback(async () => {
    if (activeStreamRef.current || undoingRef.current) return
    undoingRef.current = true; setUndoing(true)
    try {
      const res = await client.chat[":sessionId"].undo.$post({ param: { sessionId } })
      if (!res.ok) throw new Error(await getErrorMessage(res))
      const result = await res.json()
      updateMessages(prev => [...prev, { id: result.messageId, role: "assistant", content: result.content, model: result.model, mode: "BUILD", parts: [{ type: "text", text: result.content }], totalTokens: 0 }])
    } catch (error) {
      updateMessages(prev => [...prev, { id: crypto.randomUUID(), role: "error", content: error instanceof Error ? error.message : "Não foi possível desfazer." }])
    } finally { undoingRef.current = false; setUndoing(false) }
  }, [client, sessionId, updateMessages])

  const submit = useCallback(async ({ userText, mode, model }: SubmitParams) => {
    if (!userText.trim() || activeStreamRef.current || undoingRef.current) return
    if (userText.trim() === "/undo") { await undo(); return }
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: userText, mode, model }
    setPendingResume(null)
    updateMessages((prev) => [...prev, userMessage])
    await runStream({ mode, model, request: (controller) => client.chat[":sessionId"].$post(
      { param: { sessionId }, json: { content: userText, mode, model } },
      { init: { signal: controller.signal } },
    ) })
  }, [client, runStream, sessionId, updateMessages, undo])

  const confirmResume = useCallback(async () => {
    if (!pendingResume) return
    await resume({ mode: pendingResume.mode, model: pendingResume.model })
  }, [pendingResume, resume])
  const dismissResume = useCallback(() => setPendingResume(null), [])

  const decideApproval = useCallback(async (id: string, approved: boolean, remember = false) => {
    const res = await client.permissions[":sessionId"][":approvalId"].$post({ param: { sessionId, approvalId: id }, json: { approved, remember } })
    if (res.ok || res.status === 404) setPendingApprovals(prev => prev.filter(item => item.approvalId !== id))
    if (!res.ok) throw new Error(await getErrorMessage(res))
  }, [client, sessionId])

  const totalTokens = sumSessionTokens(messages) + (streaming.status === "streaming" ? streaming.totalTokens : 0)
  return { messages, streaming, submit, resume, abort, interrupt, pendingApprovals, decideApproval, totalTokens, undo, undoing, pendingResume, confirmResume, dismissResume }
}
