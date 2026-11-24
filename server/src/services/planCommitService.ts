import crypto from 'crypto';
import { db } from '../config/database.js';
import type {
  PlanStatus,
  ScheduleBlockRecord,
  SchedulePlan,
  Task,
  TaskInstance,
  UserSettings,
} from '../models/types.js';
import { getLatestPlanVersion, syncLegacyTaskProjection } from './instanceService.js';
import { syncOutboxForCommittedPlan } from './outboxService.js';

export interface ProposedInstancePlan {
  instanceId: number;
  taskId: number;
  planStatus: PlanStatus;
  allocatedMinutes: number;
  unallocatedMinutes: number;
  planReason: string | null;
  /** Blocks to keep as-is (completed, in_progress, fixed, committed, conflict) */
  preservedBlocks: ScheduleBlockRecord[];
  /** Newly computed movable blocks */
  newBlocks: Array<{
    startTime: string;
    endTime: string;
    durationMinutes: number;
    partIndex: number;
    totalParts: number;
    isFixed: boolean;
    isCommitted: boolean;
    isConcurrent: boolean;
    energyZone?: string | null;
    strategyLabel?: string | null;
    breakAfterMinutes?: number | null;
  }>;
  /** Old conflict block IDs if newly detected */
  conflictedBlockIds?: string[];
}

export interface CommitPlanInput {
  userId: number;
  expectedPlanVersion: number;
  expectedCalendarGenerations: Record<string, number>;
  triggerSource: string;
  summary: string;
  instancePlans: ProposedInstancePlan[];
  taskTitlesById: Map<number, string>;
  settings?: UserSettings;
  now?: Date;
}

export interface CommitPlanResult {
  committed: boolean;
  stale?: boolean;
  staleReason?: string;
  planVersion: number;
  plan?: SchedulePlan;
  activeBlocks: ScheduleBlockRecord[];
}

export function getCurrentCalendarGenerations(userId: number): Record<string, number> {
  const rows = db
    .prepare('SELECT id, COALESCE(current_generation, 0) as gen FROM calendar_subscriptions WHERE user_id = ? ORDER BY id ASC')
    .all(userId) as Array<{ id: number; gen: number }>;
  const map: Record<string, number> = {};
  for (const r of rows) map[String(r.id)] = r.gen;
  return map;
}

function generationsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => a[k] === b[k]);
}

/**
 * 原子发布计划版本、稳定分段 ID 与通知发件箱变更（T03, T07, C02）。
 * 提交前强制核对 plan_version 与外部日历代次；任何输入变化都使旧候选作废。
 */
export function commitSchedulePlan(input: CommitPlanInput): CommitPlanResult {
  const now = input.now || new Date();

  return db.transaction((): CommitPlanResult => {
    const currentVersion = getLatestPlanVersion(input.userId);
    if (currentVersion !== input.expectedPlanVersion) {
      return {
        committed: false,
        stale: true,
        staleReason: `plan_version_mismatch (expected ${input.expectedPlanVersion}, actual ${currentVersion})`,
        planVersion: currentVersion,
        activeBlocks: [],
      };
    }

    const currentGens = getCurrentCalendarGenerations(input.userId);
    if (!generationsEqual(currentGens, input.expectedCalendarGenerations)) {
      return {
        committed: false,
        stale: true,
        staleReason: 'calendar_generation_changed',
        planVersion: currentVersion,
        activeBlocks: [],
      };
    }

    const nextVersion = currentVersion + 1;

    db.prepare(`
      UPDATE schedule_plans
      SET status = 'superseded'
      WHERE user_id = ? AND status = 'committed'
    `).run(input.userId);

    db.prepare(`
      INSERT INTO schedule_plans (
        user_id, version, trigger_source, status, summary, calendar_generation_snapshot
      ) VALUES (?, ?, ?, 'committed', ?, ?)
    `).run(
      input.userId,
      nextVersion,
      input.triggerSource,
      input.summary,
      JSON.stringify(currentGens)
    );

    const plan = db
      .prepare('SELECT * FROM schedule_plans WHERE user_id = ? AND version = ?')
      .get(input.userId, nextVersion) as SchedulePlan;

    // Index existing active planned blocks for stable ID reuse
    const existingMovableBlocks = db.prepare(`
      SELECT * FROM schedule_blocks
      WHERE user_id = ? AND status = 'planned' AND is_fixed = 0 AND is_committed = 0
    `).all(input.userId) as ScheduleBlockRecord[];

    const movableByInstance = new Map<number, ScheduleBlockRecord[]>();
    for (const b of existingMovableBlocks) {
      const list = movableByInstance.get(b.instance_id) || [];
      list.push(b);
      movableByInstance.set(b.instance_id, list);
    }

    // Supersede all old movable planned blocks
    db.prepare(`
      UPDATE schedule_blocks
      SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND status = 'planned' AND is_fixed = 0 AND is_committed = 0
    `).run(input.userId);

    const insertBlockStmt = db.prepare(`
      INSERT INTO schedule_blocks (
        id, user_id, plan_version, instance_id, task_id,
        start_time, end_time, duration_minutes, part_index, total_parts,
        is_fixed, is_committed, is_concurrent, status, replaced_from_block_id,
        energy_zone, strategy_label, break_after_minutes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updatePreservedVersionStmt = db.prepare(`
      UPDATE schedule_blocks
      SET plan_version = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `);

    const allActiveBlocks: ScheduleBlockRecord[] = [];
    const touchedTaskIds = new Set<number>();

    for (const instPlan of input.instancePlans) {
      touchedTaskIds.add(instPlan.taskId);
      const conflictSet = new Set(instPlan.conflictedBlockIds || []);
      const preservedIds = new Set(instPlan.preservedBlocks.map(p => p.id));

      // Supersede any replaced fixed/committed/conflict blocks on this instance when explicitly rescheduling
      if (instPlan.newBlocks.length > 0) {
        const instActiveOld = db.prepare(`
          SELECT id FROM schedule_blocks
          WHERE instance_id = ? AND user_id = ? AND status IN ('planned', 'conflict')
        `).all(instPlan.instanceId, input.userId) as Array<{ id: string }>;
        for (const oldB of instActiveOld) {
          if (!preservedIds.has(oldB.id)) {
            db.prepare("UPDATE schedule_blocks SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(oldB.id);
          }
        }
      }

      // 1. Keep preserved blocks (in_progress, completed, fixed, committed, conflict)
      for (const pb of instPlan.preservedBlocks) {
        const nextBlockStatus = conflictSet.has(pb.id) ? 'conflict' : pb.status;
        updatePreservedVersionStmt.run(nextVersion, nextBlockStatus, pb.id, input.userId);
        allActiveBlocks.push({ ...pb, plan_version: nextVersion, status: nextBlockStatus });
      }

      // 2. Insert new movable blocks with stable ID matching
      const prevMovables = movableByInstance.get(instPlan.instanceId) || [];
      const usedPrevIds = new Set<string>();

      for (const nb of instPlan.newBlocks) {
        // Check exact slot match first to keep same block ID across harmless replans
        const exactMatch = prevMovables.find(
          prev =>
            !usedPrevIds.has(prev.id) &&
            prev.part_index === nb.partIndex &&
            prev.start_time === nb.startTime &&
            prev.end_time === nb.endTime
        );

        let blockId: string;
        let replacedFromId: string | null = null;

        if (exactMatch) {
          usedPrevIds.add(exactMatch.id);
          // Re-activate existing row in place to maintain stable primary key
          db.prepare(`
            UPDATE schedule_blocks
            SET plan_version = ?, status = 'planned', total_parts = ?,
                energy_zone = ?, strategy_label = ?, break_after_minutes = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            nextVersion,
            nb.totalParts,
            nb.energyZone || null,
            nb.strategyLabel || null,
            nb.breakAfterMinutes || null,
            exactMatch.id
          );
          blockId = exactMatch.id;
        } else {
          const samePartPrev = prevMovables.find(
            prev => !usedPrevIds.has(prev.id) && prev.part_index === nb.partIndex
          );
          if (samePartPrev) {
            usedPrevIds.add(samePartPrev.id);
            replacedFromId = samePartPrev.id;
          }
          blockId = `blk-${instPlan.taskId}-${instPlan.instanceId}-${crypto.randomUUID().slice(0, 8)}`;
          insertBlockStmt.run(
            blockId,
            input.userId,
            nextVersion,
            instPlan.instanceId,
            instPlan.taskId,
            nb.startTime,
            nb.endTime,
            nb.durationMinutes,
            nb.partIndex,
            nb.totalParts,
            nb.isFixed ? 1 : 0,
            nb.isCommitted ? 1 : 0,
            nb.isConcurrent ? 1 : 0,
            'planned',
            replacedFromId,
            nb.energyZone || null,
            nb.strategyLabel || null,
            nb.breakAfterMinutes || null
          );
        }

        const row = db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(blockId) as ScheduleBlockRecord;
        allActiveBlocks.push(row);
      }

      // 3. Update task_instances planning state
      db.prepare(`
        UPDATE task_instances
        SET plan_status = ?,
            allocated_minutes = ?,
            unallocated_minutes = ?,
            plan_reason = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        instPlan.planStatus,
        instPlan.allocatedMinutes,
        instPlan.unallocatedMinutes,
        instPlan.planReason,
        instPlan.instanceId
      );
    }

    // Sync notifications inside commit transaction
    syncOutboxForCommittedPlan({
      userId: input.userId,
      planVersion: nextVersion,
      activeBlocks: allActiveBlocks,
      taskTitlesById: input.taskTitlesById,
      settings: input.settings,
      now,
    });

    // Mark pending replan requests resolved
    db.prepare(`
      UPDATE replan_requests
      SET status = 'done', target_plan_version = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND status IN ('pending', 'processing')
    `).run(nextVersion, input.userId);

    // Sync legacy projection fields on tasks table
    for (const taskId of touchedTaskIds) {
      syncLegacyTaskProjection(input.userId, taskId, now);
    }

    return {
      committed: true,
      planVersion: nextVersion,
      plan,
      activeBlocks: allActiveBlocks,
    };
  })();
}
