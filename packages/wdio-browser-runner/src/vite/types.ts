import type { ErrorObject } from 'serialize-error'
import { MESSAGE_TYPES } from '../constants.js'

interface SocketMessagePayloadType<T extends MESSAGE_TYPES> {
    type: T,
    value: SocketMessageValue[T]
}

export type SocketMessageValue = {
    [MESSAGE_TYPES.consoleMessage]: ConsoleEvent
    [MESSAGE_TYPES.commandRequestMessage]: CommandRequestEvent
    [MESSAGE_TYPES.commandResponseMessage]: CommandResponseEvent
    [MESSAGE_TYPES.hookTriggerMessage]: HookTriggerEvent
    [MESSAGE_TYPES.hookResultMessage]: HookResultEvent
}

export type SocketMessagePayload<T extends MESSAGE_TYPES> = T extends any
    ? SocketMessagePayloadType<T>
    : never

export type SocketMessage = SocketMessagePayload<MESSAGE_TYPES>

export interface ConsoleEvent {
    name: 'consoleEvent'
    type: 'log' | 'info' | 'warn' | 'debug' | 'error'
    args: unknown[]
    cid: string
}

interface MessageWithPendingPromiseId {
    id: string
}

export interface HookTriggerEvent extends MessageWithPendingPromiseId {
    cid: string
    name: string
    args: unknown[]
}

export interface HookResultEvent extends MessageWithPendingPromiseId {
    error?: ErrorObject
}

export interface CommandRequestEvent extends MessageWithPendingPromiseId {
    cid: string
    commandName: string
    args: unknown[]
}

export interface CommandResponseEvent {
    id: string
    result?: unknown
    error?: ErrorObject
}
