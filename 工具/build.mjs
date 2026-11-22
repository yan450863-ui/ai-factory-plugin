import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  dependencyNodePaths,
  requireDependency,
} from './dependencies.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(toolDir);
const pluginDir = path.join(root, '插件市场', 'plugins', 'codex-factory');
const sourceDir = path.join(pluginDir, 'server');
const distDir = path.join(pluginDir, 'dist');
const nodeModules = dependencyNodePaths(toolDir);
const { build } = requireDependency('esbuild', toolDir);

const required = [
  path.join(pluginDir, 'plugin.json'),
  path.join(pluginDir, 'mcp.json'),
  path.join(sourceDir, 'mcp.mjs'),
  path.join(sourceDir, 'model-settings.mjs'),
  path.join(sourceDir, 'store.mjs'),
  path.join(sourceDir, 'panel.html'),
  path.join(sourceDir, 'panel-app.mjs'),
  path.join(pluginDir, 'skills', 'auto-factory', 'SKILL.md'),
  path.join(pluginDir, 'skills', 'factory-team', 'SKILL.md'),
  path.join(pluginDir, 'skills', 'factory-coordinator', 'SKILL.md'),
  path.join(pluginDir, 'references', 'collaboration.md'),
];

for (const file of required) {
  try {
    await fs.access(file);
  } catch {
    throw new Error(`缺少构建输入：${path.relative(root, file)}`);
  }
}

const resolvedPluginDir = path.resolve(pluginDir);
const resolvedDistDir = path.resolve(distDir);
if (path.dirname(resolvedDistDir) !== resolvedPluginDir || path.basename(resolvedDistDir) !== 'dist') {
  throw new Error(`拒绝删除插件目录范围外的构建目标：${resolvedDistDir}`);
}
await fs.rm(resolvedDistDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

const common = {
  bundle: true,
  nodePaths: nodeModules,
  logLevel: 'info',
  sourcemap: false,
};

await build({
  ...common,
  entryPoints: [path.join(sourceDir, 'mcp.mjs')],
  outfile: path.join(distDir, 'mcp.mjs'),
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

const ui = await build({
  ...common,
  entryPoints: [path.join(sourceDir, 'panel-app.mjs')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
});

const sourceHtml = await fs.readFile(path.join(sourceDir, 'panel.html'), 'utf8');
const appPlaceholder = /<script\s+type="module">\s*\/\* APP_SCRIPT \*\/\s*<\/script>/;
if ((sourceHtml.match(appPlaceholder) || []).length !== 1) {
  throw new Error('server/panel.html 必须包含唯一的 APP_SCRIPT 模块占位');
}
const inlineScript = ui.outputFiles[0].text.replaceAll('</script', '<\\/script');
const builtHtml = sourceHtml.replace(
  appPlaceholder,
  () => `<script type="module">${inlineScript}</script>`,
);
const scriptOpens = [...builtHtml.matchAll(/<script\b/gi)].length;
const scriptCloses = [...builtHtml.matchAll(/<\/script>/gi)].length;
if (scriptOpens !== 1 || scriptCloses !== 1 || builtHtml.includes('/* APP_SCRIPT */')) {
  throw new Error(`构建脚本注入结构异常：${scriptOpens}/${scriptCloses}`);
}
await fs.writeFile(path.join(distDir, 'panel.html'), builtHtml, 'utf8');

const artifacts = [
  path.join(distDir, 'mcp.mjs'),
  path.join(distDir, 'panel.html'),
];
const manifest = {
  builtAt: new Date().toISOString(),
  version: JSON.parse(await fs.readFile(path.join(pluginDir, 'plugin.json'), 'utf8')).version,
  artifacts: {},
};
for (const file of artifacts) {
  const content = await fs.readFile(file);
  manifest.artifacts[path.relative(distDir, file)] = {
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}
await fs.writeFile(
  path.join(distDir, 'build-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

console.log(`Built AI Factory Plugin ${manifest.version}: ${artifacts.map((file) => path.basename(file)).join(', ')}`);
