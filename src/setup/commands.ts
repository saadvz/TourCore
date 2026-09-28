import { z } from "zod";
import { TourHoursSchema, validateConfig } from "../config/tourCoreConfig";
import {
  addDoor,
  addUnit,
  defaultUnitDoorName,
  removeDoor,
  removeUnit,
  renameDoor,
  renameUnit,
  setAlertContact,
  setPropertyDetails,
  setRoute,
  setServices,
  setTourHours,
  setUnitDetails,
  setUnitProfile,
  setVerificationPolicy,
  SetupInputError,
  type SetupDraft,
} from "./setupActions";
import type { ProfileField } from "../config/unitProfile";

/**
 * Every draft edit a setup surface can make, with a typed input schema.
 * The browser calls these by name; a Grok Bot tool list can be generated
 * from the same table. Each command is a thin wrapper over a setup action.
 */

const Text = z.string();
const Facts = z.array(z.string());

function command<S extends z.ZodType>(input: S, run: (draft: SetupDraft, input: z.infer<S>) => SetupDraft) {
  return { input, run };
}

export const SETUP_COMMANDS = {
  setPropertyDetails: command(
    z.object({ name: Text.optional(), address: Text.optional(), timezone: Text.optional(), facts: Facts.optional() }),
    (d, i) => setPropertyDetails(d, i),
  ),
  setAlertContact: command(z.object({ name: Text.optional(), contact: Text.optional() }), (d, i) => setAlertContact(d, i)),
  /** Adds a unit together with its own door (named "<unit> Door" unless given). */
  addUnit: command(
    z.object({ name: Text, summary: Text.optional(), facts: Facts.optional(), doorName: Text.optional() }),
    (d, i) => {
      const { draft, unit } = addUnit(d, i);
      return addDoor(draft, { name: i.doorName?.trim() || defaultUnitDoorName(unit.name), kind: "UNIT", unitId: unit.id }).draft;
    },
  ),
  renameUnit: command(z.object({ unitId: Text, name: Text, alsoRenameDoor: z.boolean().optional() }), (d, i) =>
    renameUnit(d, i.unitId, i.name, { alsoRenameDoor: i.alsoRenameDoor }),
  ),
  setUnitDetails: command(z.object({ unitId: Text, summary: Text.optional(), facts: Facts.optional() }), (d, i) =>
    setUnitDetails(d, i.unitId, { summary: i.summary, facts: i.facts }),
  ),
  /** Unit details in the operator's words: bedrooms, bathrooms, monthlyRent, availability, squareFeet, floor, parking, laundry, pets, utilities, furnished, features. */
  setUnitProfile: command(z.object({ unitId: Text, values: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean()])) }), (d, i) =>
    setUnitProfile(d, i.unitId, i.values as Partial<Record<ProfileField, string | number | boolean>>),
  ),
  removeUnit: command(z.object({ unitId: Text }), (d, i) => removeUnit(d, i.unitId)),
  addDoor: command(z.object({ name: Text, kind: z.enum(["ENTRANCE", "COMMON", "UNIT"]), unitId: Text.optional() }), (d, i) => addDoor(d, i).draft),
  renameDoor: command(z.object({ doorId: Text, name: Text }), (d, i) => renameDoor(d, i.doorId, i.name)),
  removeDoor: command(z.object({ doorId: Text }), (d, i) => {
    const door = d.doors.find((x) => x.id === i.doorId);
    if (door?.kind === "UNIT") throw new SetupInputError("UNIT_DOOR_LOCKED", "A unit's own door can't be removed. Remove the unit instead.");
    return removeDoor(d, i.doorId);
  }),
  /** With onlyIfValid, a route with problems is rejected (not saved) so nothing invalid is ever saved silently. */
  setRoute: command(z.object({ unitId: Text, doorIds: z.array(Text), directions: Text.optional(), onlyIfValid: z.boolean().optional() }), (d, i) => {
    const next = setRoute(d, i.unitId, i.doorIds, { directions: i.directions });
    if (i.onlyIfValid) {
      const problem = validateConfig(next).find((issue) => issue.section === "routes" && issue.unitId === i.unitId);
      if (problem) throw new SetupInputError("ROUTE_NOT_VALID", problem.message);
    }
    return next;
  }),
  setTourHours: command(TourHoursSchema.partial(), (d, i) => setTourHours(d, i)),
  setVerificationPolicy: command(
    z.object({ mode: z.enum(["basic-form", "mock", "document-check"]).optional(), reuseForDays: z.number().int().optional() }),
    (d, i) => setVerificationPolicy(d, i),
  ),
  setServices: command(
    z.object({
      messagingMode: z.enum(["demo", "sendblue"]).optional(),
      storageMode: z.enum(["memory", "google-drive"]).optional(),
      accessMode: z.enum(["durin-mock", "durin"]).optional(),
    }),
    (d, i) => setServices(d, i),
  ),
};

export type SetupCommandName = keyof typeof SETUP_COMMANDS;

export function applySetupCommand(draft: SetupDraft, name: string, input: unknown): SetupDraft {
  const cmd = (SETUP_COMMANDS as Record<string, (typeof SETUP_COMMANDS)[SetupCommandName]>)[name];
  if (!cmd) throw new SetupInputError("UNKNOWN_ACTION", "That action isn't available.");
  const parsed = cmd.input.safeParse(input ?? {});
  if (!parsed.success) throw new SetupInputError("INPUT_INVALID", "Some of that information is missing or doesn't look right.");
  return (cmd.run as (d: SetupDraft, i: unknown) => SetupDraft)(draft, parsed.data);
}
