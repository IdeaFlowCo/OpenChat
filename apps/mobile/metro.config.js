// Monorepo-aware Metro config.
// - watchFolders extends Metro's file watcher to the monorepo root so changes
//   in /packages/* and root-hoisted deps are picked up.
// - nodeModulesPaths lets Metro resolve packages from both the app's local
//   node_modules and the root-hoisted node_modules.
// - disableHierarchicalLookup prevents Metro from walking parent directories
//   beyond the explicit paths above (avoids duplicate-package surprises with
//   npm-hoisted deps).
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
