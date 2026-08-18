import { useState, useRef, useCallback, useEffect } from "react"
import { EventSourceParserStream } from "eventsource-parser/stream"
import prettyMs from "pretty-ms"
import type { ClientResponse } from "hono/client"
import { appClient } from "../lib/api-client"
import { getErrorMessage } from "../lib/http-errors"
import type { Mode } from "@myagent/database"
import { chatStreamEventSchema, type SupportedChatModelId } from "@myagent/shared"

export type ClientMessagePart =
  | { type: "reasoning"; text: string }
  | ClientToolCallPart
  | { type: "text"; text: string }

export type ClientToolCallPart = {
  type: "tool-call"
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  status: "calling" | "done"
}

export type Message =
  | { id: string; role: "user"; content: string; mode: Mode; model: SupportedChatModelId }
  | { id: string; role: "assistant"; content: string; mode: Mode; model: SupportedChatModelId; parts: ClientMessagePart[]; duration?: string; interrupted?: boolean }
  | { id: string; role: "error"; content: string }

type StreamingState =
  | { status: "idle" }
  | { status: "streaming"; parts: ClientMessagePart[]; mode: Mode; model: SupportedChatModelId }

type ActiveStream = {
  requestId: string
  controller: AbortController
  mode: Mode
  model: SupportedChatModelId
  parts: ClientMessagePart[]
  interruptedCaptured: boolean
}

type SubmitParams = { userText: string; mode: Mode; model: SupportedChatModelId }
type RunStreamParams = {
  mode: Mode
  model: SupportedChatModelId
  request: (controller: AbortController) => Promise<ClientResponse<unknown>>
}

export function useChat(sessionId: string, initialMessages: Message[]) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [streaming, setStreaming] = useState<StreamingState>({ status: "idle" })
  const activeStreamRef = useRef<ActiveStream | null>(null)
  const autoResumeAttemptedIdRef = useRef<string | null>(null)

  const updateMessages = useCallback((updater: (prev: Message[]) => Message[]) => setMessages(updater), [])
  const isActiveRequest = useCallback((requestId: string) => activeStreamRef.current?.requestId === requestId, [])

  const emitParts = useCallback((requestId: string, parts: ClientMessagePart[]) => {
    if (!isActiveRequest(requestId)) return
    const activeStream = activeStreamRef.current
    if (!activeStream) return
    const snapshot = [...parts]
    activeStream.parts = snapshot
    setStreaming({ status: "streaming", parts: snapshot, mode: activeStream.mode, model: activeStream.model })
  }, [isActiveRequest])

  const clearStream = useCallback((requestId: string) => {
    if (!isActiveRequest(requestId)) return
    activeStreamRef.current = null
    setStreaming({ status: "idle" })
  }, [isActiveRequest])

  const captureInterruptedMessage = useCallback((activeStream: ActiveStream) => {
    if (activeStream.interruptedCaptured || activeStream.parts.length === 0) return
    activeStream.interruptedCaptured = true
    const parts = [...activeStream.parts]
    const content = parts.filter((part): part is Extract<ClientMessagePart, { type: "text" }> => part.type === "text").map((part) => part.text).join("")
    updateMessages((prev) => [...prev, {
      id: crypto.randomUUID(), role: "assistant", content,
      mode: activeStream.mode, model: activeStream.model, parts, interrupted: true,
    }])
  }, [updateMessages])

  const handleStream = useCallback(async (response: ClientResponse<unknown>, activeStream: ActiveStream) => {
    if (!isActiveRequest(activeStream.requestId)) return
    if (!response.ok) {
      updateMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "error", content: await getErrorMessage(response) }])
      return
    }
    if (!response.body) {
      updateMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "error", content: "The server returned an empty response body." }])
      return
    }

    const parts: ClientMessagePart[] = []
    const stream = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())

    for await (const { data } of stream) {
      if (!isActiveRequest(activeStream.requestId)) return
      let event: ReturnType<typeof chatStreamEventSchema.parse>
      try {
        event = chatStreamEventSchema.parse(JSON.parse(data))
      } catch (error) {
        updateMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "error", content: error instanceof Error ? error.message : "Invalid stream event" }])
        return
      }

      switch (event.type) {
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
          }])
          return
        }
        case "error":
          updateMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "error", content: event.message }])
          return
      }
    }
  }, [emitParts, isActiveRequest, updateMessages])

  const runStream = useCallback(async ({ mode, model, request }: RunStreamParams) => {
    const controller = new AbortController()
    const activeStream: ActiveStream = { requestId: crypto.randomUUID(), controller, mode, model, parts: [], interruptedCaptured: false }
    activeStreamRef.current = activeStream
    setStreaming({ status: "streaming", parts: [], mode, model })
    try {
      await handleStream(await request(controller), activeStream)
    } catch (error) {
      if (controller.signal.aborted) return
      if (isActiveRequest(activeStream.requestId)) {
        updateMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "error", content: error instanceof Error ? error.message : String(error) }])
      }
    } finally {
      clearStream(activeStream.requestId)
    }
  }, [clearStream, handleStream, isActiveRequest, updateMessages])

  const stopActiveStream = useCallback((capturePartial: boolean) => {
    const activeStream = activeStreamRef.current
    if (!activeStream) return
    if (capturePartial) captureInterruptedMessage(activeStream)
    activeStream.controller.abort()
    activeStreamRef.current = null
    setStreaming({ status: "idle" })
  }, [captureInterruptedMessage])

  const abort = useCallback(() => stopActiveStream(false), [stopActiveStream])
  const interrupt = useCallback(() => stopActiveStream(true), [stopActiveStream])

  const resume = useCallback(async ({ mode, model }: Omit<SubmitParams, "userText">) => {
    if (activeStreamRef.current) return
    await runStream({ mode, model, request: (controller) => appClient.chat[":sessionId"].resume.$post(
      { param: { sessionId } }, { init: { signal: controller.signal } },
    ) })
  }, [runStream, sessionId])

  const submit = useCallback(async ({ userText, mode, model }: SubmitParams) => {
    if (!userText.trim() || activeStreamRef.current) return
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: userText, mode, model }
    autoResumeAttemptedIdRef.current = userMessage.id
    updateMessages((prev) => [...prev, userMessage])
    await runStream({ mode, model, request: (controller) => appClient.chat[":sessionId"].$post(
      { param: { sessionId }, json: { content: userText, mode, model } },
      { init: { signal: controller.signal } },
    ) })
  }, [runStream, sessionId, updateMessages])

  useEffect(() => {
    const last = messages.at(-1)
    if (!last || last.role !== "user" || streaming.status !== "idle" || activeStreamRef.current) return
    if (autoResumeAttemptedIdRef.current === last.id) return
    autoResumeAttemptedIdRef.current = last.id
    void resume({ mode: last.mode, model: last.model })
  }, [messages, resume, streaming.status])

  return { messages, streaming, submit, resume, abort, interrupt }
}
