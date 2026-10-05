import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePhone } from "../core/phone";
import { writeJsonAtomic } from "../storage/atomicWrite";

export interface PauseWaiter {
  phone: string;
  unitId?: string;
  at: string;
}

interface PauseWaiterFile {
  schemaVersion: 1;
  waiters: PauseWaiter[];
}

export function pauseWaitersPath(root: string, propertyId: string): string {
  return join(root, "properties", propertyId, "operator", "pause-waiters.json");
}

export function listWaiters(root: string, propertyId: string): PauseWaiter[] {
  const path = pauseWaitersPath(root, propertyId);
  if (!existsSync(path)) return [];
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as Partial<PauseWaiterFile>).waiters ?? [];
  } catch {
    return [];
  }
}

function keyOf(waiter: PauseWaiter): string {
  return `${waiter.phone}|${waiter.unitId ?? ""}`;
}

function writeWaiters(root: string, propertyId: string, waiters: PauseWaiter[]): void {
  writeJsonAtomic(pauseWaitersPath(root, propertyId), { schemaVersion: 1, waiters } satisfies PauseWaiterFile);
}

/** Remembers a visitor who was told tours would come back, or who got a paused-unit line. */
export function rememberWaiter(root: string, propertyId: string, waiter: PauseWaiter): void {
  const phone = normalizePhone(waiter.phone);
  if (!phone || phone === "+") return;
  const next: PauseWaiter = { phone, at: waiter.at, ...(waiter.unitId ? { unitId: waiter.unitId } : {}) };
  const waiters = listWaiters(root, propertyId);
  if (waiters.some((existing) => keyOf(existing) === keyOf(next))) return;
  writeWaiters(root, propertyId, [...waiters, next]);
}

export function waitersFor(root: string, propertyId: string, unitId?: string): PauseWaiter[] {
  const waiters = listWaiters(root, propertyId);
  return unitId ? waiters.filter((waiter) => waiter.unitId === unitId) : waiters;
}

export function uniquePhones(waiters: PauseWaiter[]): string[] {
  return [...new Set(waiters.map((waiter) => waiter.phone))];
}

/** Drops every waiting visitor. Used after a property resume send, or when the property is removed. */
export function dropWaiters(root: string, propertyId: string): void {
  if (!existsSync(pauseWaitersPath(root, propertyId))) return;
  writeWaiters(root, propertyId, []);
}

/** Drops waiters recorded for one unit after that unit is resumed and notified. */
export function dropUnitWaiters(root: string, propertyId: string, unitId: string): void {
  writeWaiters(
    root,
    propertyId,
    listWaiters(root, propertyId).filter((waiter) => waiter.unitId !== unitId),
  );
}
