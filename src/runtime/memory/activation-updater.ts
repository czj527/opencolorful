import type Database from "better-sqlite3";
import type { MemoryFactStore } from "../../storage/memory/fact-store.js";
import type { MemoryRecallStore } from "../../storage/memory/recall-store.js";
import { computeActivation } from "./intensity-calculator.js";

export class ActivationUpdater {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      database: Database.Database;
      factStore: MemoryFactStore;
      recallStore: MemoryRecallStore;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  updateForHits(input: { agentId: string; targetIds: readonly string[] }): void {
    this.run(input.agentId, input.targetIds);
  }

  rebuildAll(agentId: string): void {
    const facts = this.deps.factStore.listByAgent(agentId, { limit: 1_000_000 });
    this.run(agentId, facts.map((fact) => String(fact.id)));
  }

  private run(agentId: string, targetIds: readonly string[]): void {
    const uniqueIds = [...new Set(targetIds)];
    const transaction = this.deps.database.transaction(() => {
      const recalls = this.deps.recallStore.listByAgent(agentId, { limit: 1_000_000 });
      for (const targetId of uniqueIds) {
        const hitDates = recalls
          .filter((recall) => recall.targetType === "fact" && recall.targetId === targetId)
          .map((recall) => recall.createdAt);
        const activation = computeActivation({ hitDates, now: this.now() });
        this.deps.database
          .prepare("UPDATE memory_facts SET activation_strength = ?, updated_at = ? WHERE id = ? AND agent_id = ?")
          .run(activation, this.now().toISOString(), Number(targetId), agentId);
      }
    });
    transaction();
  }
}
