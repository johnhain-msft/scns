export {
  formatHookPayload,
  formatEventPayload,
  forwardToBroker,
  createEventForwarder,
} from './event-forwarder.js'
export type {
  CopilotHookInput,
  CopilotEventData,
  BrokerHookPayload,
  ForwarderConfig,
  EventForwarderApi,
} from './event-forwarder.js'

export { createContextInjector } from './context-injector.js'
export type {
  InjectionConfig,
  InjectionContext,
  ContextInjectorConfig,
  ContextInjectorApi,
} from './context-injector.js'

export { TOOL_DEFINITIONS, createToolHandlers, toSdkTools } from './tool-definitions.js'
export type { ToolDefinition, ToolHandler, ToolWithHandler } from './tool-definitions.js'

export { generateExtensionSource, validateBrokerUrl } from './extension-template.js'
export type { ExtensionTemplateConfig } from './extension-template.js'
