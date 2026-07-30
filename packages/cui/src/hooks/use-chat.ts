import { useState, useRef, useCallback, useEffect, act } from "react"
import { EventSourceParserStream } from "eventsource-parser/stream"
import prettyMs from "pretty-ms"
import type { ClientResponse } from "hono/client"
import { appClient } from "../lib/api-client"
import { getErrorMessage } from "../lib/http-errors"
import type { Mode } from "../../../database/generated/prisma/enums"
import { chatStreamEventSchema, type SupportedChatModelId } from "@myagent/shared"

export type ClientMessagePart = 
| {type:"reasoning";text:string}
| ClientToolCallPart
|{type:"text";text:string}

export type ClientToolCallPart = {
  type:"tool-call",
  id:string,
  name:string,
  args:Record<string,unknown>
  result?:string
  status:"calling"|"done"
}

export type Message =
  | {
      id: string
      role: "user"
      content: string
      mode: Mode
      model: SupportedChatModelId
    }
  | {
      id: string
      role: "assistant"
      content: string
      mode: Mode
      model: SupportedChatModelId
      parts: ClientMessagePart[]
      duration?: string
      interrupted?:boolean
    }
  | {
      id: string
      role: "error"
      content: string
    }

type StreamingState =
  | { status: "idle" }
  | {
      status: "streaming"
      parts: ClientMessagePart[]
      mode: Mode
      model: SupportedChatModelId
    }

type ActiveStream = {
  requestId: string
  controller: AbortController
  mode: Mode
  model: SupportedChatModelId
  parts: ClientMessagePart[]
  interruptedCaptured:boolean
}

type SubmitParams = {
  userText: string
  mode: Mode
  model: SupportedChatModelId
}

type RunStreamParams = {
  mode: Mode
  model: SupportedChatModelId
  request: (controller: AbortController) => Promise<ClientResponse<unknown>>
}

export function useChat(sessionId: string, initialMessages: Message[]) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [streaming, setStreaming] = useState<StreamingState>({
    status: "idle",
  })
  const activeStreamRef = useRef<ActiveStream | null>(null)
  // Tracks the id of the last user message that a stream (submit or
  // auto-resume) has already been started for, so the auto-resume effect
  // below doesn't fire twice for the same message.
  const autoResumeAttemptedIdRef = useRef<string | null>(null)

  const updateMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    setMessages((prev) => updater(prev))
  }, [])

  const isActiveRequest = useCallback((requestId: string) => {
    return activeStreamRef.current?.requestId === requestId
  }, [])

  const emitParts = useCallback(
    (requestId: string, parts: ClientMessagePart[]) => {
      if (!isActiveRequest(requestId)) return
      const snapshot = [...parts]
      const activeStream = activeStreamRef.current
      if (!activeStream) return
      activeStream.parts = snapshot
      setStreaming({
        status: "streaming",
        parts: snapshot,
        mode: activeStream.mode,
        model: activeStream.model,
      })
    },
    [isActiveRequest],
  )

  const clearStream = useCallback(
    (requestId: string) => {
      if (!isActiveRequest(requestId)) return
      activeStreamRef.current = null
      setStreaming({ status: "idle" })
    },
    [isActiveRequest],
  )

  const captureInterruptedMessage = useCallback((
    activeStream:ActiveStream
  )=>{
    if (activeStream.interruptedCaptured || activeStream.parts.length===0){
      return
    } 

    activeStream.interruptedCaptured = true
    const parts = [...activeStream.parts]
    const fullText = parts
    .filter((p)=>p.type==="text")
    .map((p)=>p.text)
    .join("")

    updateMessages((prev)=>[
      ...prev,
      {
        id:crypto.randomUUID(),
        role:"assistant",
        content:fullText,
        mode:activeStream.mode,
        model:activeStream.model,
        parts,
        interrupted:true
      }
    ])
  },[updateMessages])

  const handleStream = useCallback(
    async (response: ClientResponse<unknown>, activeStream: ActiveStream) => {
      if (!isActiveRequest(activeStream.requestId)) return
      if (!response.ok) {
        const message = await getErrorMessage(response)
        updateMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "error",
            content: message,
          },
        ])
        return
      }

      const parts: ClientMessagePart[] = []

      if (!response.body) {
        updateMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "error",
            content: "The server returned an empty response body.",
          },
        ])
        return
      }

      const stream = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream())

      for await (const { data } of stream) {
        if (!isActiveRequest(activeStream.requestId)) return
        let event

        try {
          event = chatStreamEventSchema.parse(JSON.parse(data))
        } catch (e) {
          const message = e instanceof Error ? e.message : "Invalid stream event"
          updateMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "error",
              content: message,
            },
          ])
          break
        }

        switch (event.type) {
          case "reasoning-delta":{
            const last = parts[parts.length-1]
            if (last&&last.type==="reasoning"){
              last.text+=event.text
            }else{
              parts.push({type:"reasoning",text:event.text})
            }
            emitParts(activeStream.requestId,parts)
            break
          }
          case "tool-result":{
            const tc = parts.find((p):p is ClientToolCallPart=>p.type==="tool-call" && p.id===event.toolCallId)
            if (tc){
              tc.result=event.result
              tc.status="done"
            }
            emitParts(activeStream.requestId,parts)
            break
          }
          case "tool-call":{
            parts.push({
              type:"tool-call",
              id:event.toolCallId,
              name:event.toolName,
              args:event.args,
              status:"calling"
            })
            emitParts(activeStream.requestId,parts)
            break
          }
          case "text-delta": {
            const last = parts[parts.length - 1]
            if (last && last.type === "text") {
              last.text += event.text
            } else {
              parts.push({ type: "text", text: event.text })
            }
            emitParts(activeStream.requestId, parts)
            break
          }
          case "done": {
            if (!isActiveRequest(activeStream.requestId)) return
            const fullText = parts
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("")

            updateMessages((prev) => [
              ...prev,
              {
                id: event.messageId,
                role: "assistant",
                content: fullText,
                mode: activeStream.mode,
                model: activeStream.model,
                duration: prettyMs(event.durationMs),
                parts: [...parts],
              },
            ])
            break
          }
          case "error": {
            updateMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "error",
                content: event.message,
              },
            ])
            break
          }
        }
      }
    },
    [updateMessages, emitParts, isActiveRequest],
  )

  const runStream = useCallback(
    async ({ mode, model, request }: RunStreamParams) => {
      const controller = new AbortController()
      const activeStream: ActiveStream = {
        requestId: crypto.randomUUID(),
        controller,
        mode,
        model,
        parts: [],
        interruptedCaptured:false
      }

      activeStreamRef.current = activeStream
      setStreaming({ status: "streaming", parts: [], mode, model })

      try {
        const response = await request(controller)
        await handleStream(response, activeStream)
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          return
        }

        if (!isActiveRequest(activeStream.requestId)) return

        const msg = e instanceof Error ? e.message : String(e)
        updateMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "error",
            content: msg,
          },
        ])
      } finally {
        clearStream(activeStream.requestId)
      }
    },
    [clearStream, handleStream, isActiveRequest, updateMessages],
  )

  // IMPORTANTE: stopActiveStream precisa ser declarado ANTES de abort/interrupt,
  // pois ambos o referenciam no array de dependências do useCallback.
  const stopActiveStream = useCallback((capturePartial: boolean) => {
    const activeStream = activeStreamRef.current

    if (!activeStream) return

    if (capturePartial) {
      captureInterruptedMessage(activeStream)
    }

    activeStreamRef.current = null
    setStreaming({ status: "idle" })
    activeStream.controller.abort()
  }, [captureInterruptedMessage])

  const abort = useCallback(() => {
    stopActiveStream(false)
  }, [stopActiveStream])

  const interrupt = useCallback(() => {
    stopActiveStream(true)
  }, [stopActiveStream])

  const resume = useCallback(
    async ({ mode, model }: Omit<SubmitParams, "userText">) => {
      await runStream({
        mode,
        model,
        request: async (controller) => {
          return appClient.chat[":sessionId"].resume.$post(
            { param: { sessionId } },
            { init: { signal: controller.signal } },
          )
        },
      })
    },
    [runStream, sessionId],
  )

  const submit = useCallback(
    async ({ userText, mode, model }: SubmitParams) => {
      if (activeStreamRef.current) return

      stopActiveStream(true)


      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: userText,
        mode,
        model,
      }


      autoResumeAttemptedIdRef.current = userMessage.id
      updateMessages((prev) => [...prev, userMessage])

      await runStream({
        mode,
        model,
        request: async (controller) => {
          return appClient.chat[":sessionId"].$post(
            { param: { sessionId }, json: { content: userText, mode, model } },
            { init: { signal: controller.signal } },
          )
        },
      })
    },
    [runStream, sessionId, updateMessages, stopActiveStream],
  )

  // Auto-resume: if the conversation currently ends on a user message with
  // no reply (e.g. the page was reloaded mid-stream, or a previous
  // submit/resume failed to complete), pick the stream back up automatically.
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last || last.role !== "user") return
    if (streaming.status !== "idle") return
    if (activeStreamRef.current) return
    if (autoResumeAttemptedIdRef.current === last.id) return

    autoResumeAttemptedIdRef.current = last.id
    void resume({ mode: last.mode, model: last.model })
  }, [messages, streaming.status, resume])

  return {
    messages,
    streaming,
    submit,
    resume,
    abort,
    interrupt
  }
}