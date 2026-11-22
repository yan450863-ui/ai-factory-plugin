import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function dependencyRoots(toolDir) {
  return [path.resolve(toolDir)];
}

export function dependencyNodePaths(toolDir) {
  return dependencyRoots(toolDir)
    .map((root) => path.join(root, 'node_modules'))
    .filter((candidate) => fs.existsSync(candidate));
}

export function resolveDependency(name, toolDir) {
  if (!name) throw new Error('依赖名不能为空');
  const errors = [];
  const seen = new Set();
  for (const dependencyRoot of dependencyRoots(toolDir)) {
    const packageJson = path.join(dependencyRoot, 'package.json');
    if (!fs.existsSync(packageJson) || seen.has(packageJson)) continue;
    seen.add(packageJson);
    const require = createRequire(packageJson);
    try {
      return require.resolve(name);
    } catch (error) {
      errors.push(`${packageJson}: ${error.code || error.message}`);
    }
  }
  throw new Error(
    `找不到依赖 ${name}。请先在“${toolDir}”运行 npm install：${errors.join('; ')}`,
  );
}

export function requireDependency(name, toolDir) {
  const candidate = resolveDependency(name, toolDir);
  const require = createRequire(path.join(path.resolve(toolDir), 'package.json'));
  return require(candidate);
}

export async function importDependency(name, toolDir) {
  const candidate = resolveDependency(name, toolDir);
  return import(pathToFileURL(candidate).href);
}
