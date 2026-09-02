// Monorepo-aware Metro config.
// - watchFolders extends Metro's file watcher to the monorepo root so changes
//   in /packages/* and root-hoisted deps are picked up.
// - nodeModulesPaths lets Metro resolve packages from both the app's local
//   node_modules and the root-hoisted node_modules.
// - Hierarchical lookup remains enabled so packages can resolve dependencies
//   that npm nests beneath them when the root workspace has a conflicting
//   version (for example, @react-navigation/core's nanoid dependency).
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
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
