// Capability kernel — declarative subsystem lifecycle.
//
// Replaces the mega Orchestrator.init({ memory, personality, agents, ... })
// with per-subsystem capability manifests. Each subsystem declares what it
// produces, what it requires, and its lifecycle hooks. The kernel topologically
// sorts and boots them in dependency order. Shutdown runs in reverse order.
//
// Benefits:
// - Adding a new subsystem is a manifest file, not a diff across orchestrator.
// - Dependencies are explicit — missing deps fail loudly at boot.
// - Lifecycle is uniform — no forgotten stop() calls.
// - Tests can provide fake capabilities for isolated subsystem tests.

import { createLogger } from '../utils/logger.js';

const log = createLogger('CapabilityKernel');

/**
 * A capability produced by a subsystem. Typed as any here; consumers can
 * cast to their expected type. A runtime tag could be added if stricter
 * type safety becomes necessary.
 */
export type Capability = unknown;

/**
 * A subsystem's manifest. The kernel reads this to orchestrate lifecycle.
 * All fields are optional except name; a subsystem with no lifecycle hooks
 * is just metadata (useful for declaring static capabilities).
 */
export interface SubsystemManifest<T extends Capability = Capability> {
  /** Unique subsystem name. */
  name: string;
  /**
   * Names of capabilities this subsystem needs to initialize. The kernel
   * will provide them (already initialized) in the `deps` argument to init.
   */
  requires?: readonly string[];
  /**
   * Names of capabilities this subsystem exposes to others. Typically
   * includes the subsystem's own name plus any sub-capabilities.
   */
  provides: readonly string[];
  /**
   * Build the capability. Called once in topological order. Deps are
   * guaranteed to be initialized before this runs.
   */
  init(deps: Record<string, Capability>): T | Promise<T>;
  /**
   * Optional — run after all subsystems are initialized. Good place for
   * work that needs the full system up (e.g. schedulers, event hooks).
   */
  start?(capability: T): void | Promise<void>;
  /**
   * Optional — graceful shutdown. Called in reverse-topological order
   * so a subsystem's deps are still alive when it stops.
   */
  stop?(capability: T): void | Promise<void>;
}

interface BootedSubsystem {
  manifest: SubsystemManifest;
  capability: Capability;
}

/**
 * CapabilityKernel — registers subsystems, boots them in dependency order,
 * and tears them down in reverse order on shutdown.
 */
export class CapabilityKernel {
  private manifests = new Map<string, SubsystemManifest>();
  private booted: BootedSubsystem[] = [];
  private state: 'idle' | 'initializing' | 'running' | 'stopping' | 'stopped' = 'idle';

  /** Register a subsystem manifest. Order of registration doesn't matter — the kernel sorts by dependency. */
  register<T>(manifest: SubsystemManifest<T>): void {
    if (this.state !== 'idle') {
      throw new Error(`Cannot register '${manifest.name}' — kernel is ${this.state}`);
    }
    if (this.manifests.has(manifest.name)) {
      throw new Error(`Duplicate subsystem name: '${manifest.name}'`);
    }
    this.manifests.set(manifest.name, manifest as SubsystemManifest);
  }

  /**
   * Boot every registered subsystem in dependency order. Each subsystem's
   * init() receives a `deps` map of already-initialized dependencies.
   * Calls start() on each subsystem after all are initialized.
   */
  async boot(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot boot — kernel is ${this.state}`);
    }
    this.state = 'initializing';

    const order = this.topoSort();
    const capabilityMap = new Map<string, Capability>();

    for (const m of order) {
      const deps: Record<string, Capability> = {};
      for (const req of m.requires ?? []) {
        const cap = capabilityMap.get(req);
        if (cap === undefined) {
          throw new Error(`Subsystem '${m.name}' requires '${req}' which was not provided by any registered subsystem`);
        }
        deps[req] = cap;
      }
      log.debug({ subsystem: m.name }, 'Initializing subsystem');
      const capability = await m.init(deps);
      this.booted.push({ manifest: m, capability });
      // Register every provided capability name under the initialized value.
      // Most subsystems provide just their own name, but some (e.g. memory)
      // could provide multiple sub-capabilities.
      for (const provided of m.provides) {
        capabilityMap.set(provided, capability);
      }
    }

    // All initialized — call start() on each (in boot order).
    for (const b of this.booted) {
      if (b.manifest.start) {
        try {
          await b.manifest.start(b.capability);
        } catch (err) {
          log.error({ err, subsystem: b.manifest.name }, 'Subsystem start() threw — continuing');
        }
      }
    }

    this.state = 'running';
    log.info({ count: this.booted.length }, 'Kernel running');
  }

  /**
   * Shut down every subsystem in reverse boot order. Errors in stop() are
   * logged but don't prevent other subsystems from stopping.
   */
  async shutdown(): Promise<void> {
    if (this.state !== 'running') {
      log.warn({ state: this.state }, 'Kernel shutdown called outside running state');
    }
    this.state = 'stopping';

    for (let i = this.booted.length - 1; i >= 0; i--) {
      const b = this.booted[i]!;
      if (!b.manifest.stop) continue;
      try {
        await b.manifest.stop(b.capability);
      } catch (err) {
        log.error({ err, subsystem: b.manifest.name }, 'Subsystem stop() threw');
      }
    }

    this.booted = [];
    this.state = 'stopped';
    log.info('Kernel stopped');
  }

  /** Get an initialized capability by name. Throws if not booted. */
  get<T = Capability>(name: string): T {
    const found = this.booted.find((b) => b.manifest.provides.includes(name));
    if (!found) throw new Error(`Capability not found: ${name}`);
    return found.capability as T;
  }

  /** True if the named capability has been registered and booted. */
  has(name: string): boolean {
    return this.booted.some((b) => b.manifest.provides.includes(name));
  }

  /** Current kernel lifecycle state (for diagnostics). */
  getState(): typeof this.state {
    return this.state;
  }

  /**
   * Kahn's algorithm — topologically sort manifests so that a subsystem's
   * dependencies come before it. Throws if a cycle is detected or a
   * required capability is not provided by any registered subsystem.
   */
  private topoSort(): SubsystemManifest[] {
    // Map each provided capability to its manifest
    const byCapability = new Map<string, SubsystemManifest>();
    for (const m of this.manifests.values()) {
      for (const cap of m.provides) {
        if (byCapability.has(cap)) {
          throw new Error(`Capability '${cap}' provided by multiple subsystems`);
        }
        byCapability.set(cap, m);
      }
    }

    // Compute indegree
    const indegree = new Map<SubsystemManifest, number>();
    const dependents = new Map<SubsystemManifest, SubsystemManifest[]>();
    for (const m of this.manifests.values()) {
      indegree.set(m, 0);
      dependents.set(m, []);
    }
    for (const m of this.manifests.values()) {
      for (const req of m.requires ?? []) {
        const provider = byCapability.get(req);
        if (!provider) {
          throw new Error(`Subsystem '${m.name}' requires '${req}' but no registered subsystem provides it`);
        }
        if (provider === m) continue; // self-provide — ignore
        indegree.set(m, (indegree.get(m) ?? 0) + 1);
        dependents.get(provider)!.push(m);
      }
    }

    // Queue initially zero-indegree nodes
    const queue: SubsystemManifest[] = [];
    for (const [m, deg] of indegree) {
      if (deg === 0) queue.push(m);
    }

    const result: SubsystemManifest[] = [];
    while (queue.length > 0) {
      const m = queue.shift()!;
      result.push(m);
      for (const dep of dependents.get(m) ?? []) {
        const newDeg = (indegree.get(dep) ?? 0) - 1;
        indegree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }

    if (result.length !== this.manifests.size) {
      const stuck = Array.from(indegree.entries())
        .filter(([, d]) => d > 0)
        .map(([m]) => m.name);
      throw new Error(`Dependency cycle detected among: ${stuck.join(', ')}`);
    }

    return result;
  }
}
