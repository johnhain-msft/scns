export {
  installExtension,
  uninstallExtension,
  type FsOps,
  type InstallExtensionOptions,
  type InstallResult,
} from './install-extension.js'

export {
  generateLaunchAgentPlist,
  generateSystemdUnit,
  getServicePaths,
  detectPlatform,
  type ServiceConfig,
  type ServicePaths,
} from './service-generators.js'

export {
  generateHooksConfig,
  setupHooks,
  type HooksFsOps,
  type SetupHooksOptions,
  type HooksConfig,
  type SetupResult,
} from './setup-hooks.js'
