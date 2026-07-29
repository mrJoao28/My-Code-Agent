import { anthropic } from "@ai-sdk/anthropic"
import { openai } from "@ai-sdk/openai"
import {
    findSupportedChatModel,
    type SupportedChatModel,
    type SupportedChatModelId,
    type SupportedProvider
} from "@myagent/shared"
import type { LanguageModel } from "ai"
import type {ProviderOptions} from "@ai-sdk/provider-utils"




type AnthropicModelId = Extract<SupportedChatModel, { provider: "anthropic" }>["id"]
type OpenAIModelId = Extract<SupportedChatModel, { provider: "openai" }>["id"]

export type ResolvedModel = {
    model:LanguageModel,
    provider:SupportedProvider,
    modelId:SupportedChatModelId,
    providerOptions?:ProviderOptions
}

const ANTHROPIC_PROVIDER_OPTIONS:Partial<Record<AnthropicModelId,ProviderOptions>>={
    "claude-opus-4-6":{
        anthropic:{
            thinking:{
                type:"enabled",
                budgeTokens:10000
            }
        }
    },
    "claude-sonnet-4-6":{
        anthropic:{
            thinking:{
                type:"enabled",
                budgetTokens:10000
            }
        }
    }
}

const OPENAI_PROVIDER_OPTIONS:Partial<Record<OpenAIModelId,ProviderOptions>>={
    "gpt-5.4":{
        anthropic:{
            thinking:{
                reasoningSummary:"detailed"
            }
        }
    },
}

//i will add more
function assertUnsupportedProvider(provider: never): never {
    throw new Error(`Unsupported provider: ${provider}`)
}

function resolveAnthropicModel(modelId: AnthropicModelId): ResolvedModel {
    return {
        model: anthropic(modelId),
        provider: 'anthropic',
        modelId,
        providerOptions:ANTHROPIC_PROVIDER_OPTIONS[modelId]
    }
}

function resolveOpenAIModel(modelId: OpenAIModelId): ResolvedModel {
    return {
        model: openai(modelId),
        provider: 'openai',
        modelId,
        providerOptions:OPENAI_PROVIDER_OPTIONS[modelId]
    }
}

function resolveSupportChatModel(model: SupportedChatModel): ResolvedModel {
    const provider = model.provider

    switch (provider) {
        case "anthropic":
            return resolveAnthropicModel(model.id)
        case "openai":
            return resolveOpenAIModel(model.id)
        default:
            return assertUnsupportedProvider(provider)
    }
}

export function isSupportedChatModel(modelId: string): modelId is SupportedChatModelId {
    return findSupportedChatModel(modelId) !== null
}

export function resolveChatModel(modelId: string): ResolvedModel {
    const model = findSupportedChatModel(modelId)
    if (!model) {
        throw new Error(`Unsupported models: ${modelId}`)
    }

    return resolveSupportChatModel(model)
}