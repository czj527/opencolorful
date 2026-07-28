import type { SandboxBackendFactory } from "./backend.js";

/**
 * 沙箱后端注册表 — 全局注册和查找可用的 SandboxBackendFactory。
 *
 * 插件或其他模块可通过 registerSandboxBackend() 注册自定义后端，
 * 运行时通过 getSandboxBackend() 按 id 查找。
 */
const backendRegistry = new Map<string, SandboxBackendFactory>();

/**
 * 注册一个沙箱后端工厂。
 *
 * 如果同 id 已存在则覆盖（最后注册者优先）。
 */
export function registerSandboxBackend(factory: SandboxBackendFactory): void {
  backendRegistry.set(factory.id, factory);
}

/**
 * 按 id 查找沙箱后端工厂。
 *
 * @returns 找到的工厂，未注册时返回 undefined
 */
export function getSandboxBackend(id: string): SandboxBackendFactory | undefined {
  return backendRegistry.get(id);
}

/**
 * 列出所有已注册的后端 id。
 */
export function listSandboxBackends(): string[] {
  return [...backendRegistry.keys()];
}
