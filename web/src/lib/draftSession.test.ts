import { describe, expect, it } from "vitest";
import { acknowledgeSubmitted, discardToRemote, receiveRemote, type DraftSession, type SubmittedDraft } from "./draftSession";

const equal = (a: string, b: string) => a === b;
const clean = (): DraftSession<string> => ({ sessionKey: "alice", baseline: { value: "original", revision: "r1" }, draft: "original", remote: null });
const submitted: SubmittedDraft<string> = { sessionKey: "alice", value: "submitted", revision: "r1", requestId: 1 };

describe("draft session confirmation", () => {
  it("accepts a remote refresh when clean", () => {
    expect(receiveRemote(clean(), { value: "fresh", revision: "r2" }, equal)).toEqual({ sessionKey: "alice", baseline: { value: "fresh", revision: "r2" }, draft: "fresh", remote: null });
  });
  it("keeps dirty input and its original revision when remote changes", () => {
    expect(receiveRemote({ ...clean(), draft: "mine" }, { value: "remote", revision: "r3" }, equal)).toEqual({ sessionKey: "alice", baseline: { value: "original", revision: "r1" }, draft: "mine", remote: { value: "remote", revision: "r3" } });
  });
  it("preserves a newer remote revision after the older save response", () => {
    const state = receiveRemote({ ...clean(), draft: "submitted" }, { value: "external", revision: "r3" }, equal);
    expect(acknowledgeSubmitted(state, submitted, { value: "canonical", revision: "r2" }, equal)).toEqual({ sessionKey: "alice", baseline: { value: "canonical", revision: "r2" }, draft: "canonical", remote: { value: "external", revision: "r3" } });
  });
  it("confirms canonical values while keeping edits made after submission dirty", () => {
    const next = acknowledgeSubmitted({ ...clean(), draft: "late" }, submitted, { value: "canonical", revision: "r2" }, equal);
    expect(next.draft).toBe("late"); expect(next.baseline).toEqual({ value: "canonical", revision: "r2" });
  });
  it("accepts the canonical remote document at the returned save revision", () => {
    const state = { ...clean(), draft: "submitted", remote: { value: "canonical", revision: "r2" } };
    expect(acknowledgeSubmitted(state, submitted, { value: "submitted", revision: "r2" }, equal)).toEqual({ sessionKey: "alice", baseline: { value: "canonical", revision: "r2" }, draft: "canonical", remote: null });
  });
  it("does not alter a different logical session", () => {
    const bob = { ...clean(), sessionKey: "bob" };
    expect(acknowledgeSubmitted(bob, submitted, { value: "canonical", revision: "r2" }, equal)).toBe(bob);
  });
  it("discards to the known remote state or confirmed baseline", () => {
    expect(discardToRemote({ ...clean(), draft: "mine", remote: { value: "remote", revision: "r3" } })).toEqual({ sessionKey: "alice", baseline: { value: "remote", revision: "r3" }, draft: "remote", remote: null });
    expect(discardToRemote({ ...clean(), draft: "mine" })).toEqual(clean());
  });
  it("keeps a conflict until explicitly discarded even when draft matches baseline", () => {
    const state = { ...clean(), remote: { value: "remote", revision: "r3" } };
    expect(receiveRemote(state, { value: "original", revision: "r1" }, equal)).toBe(state);
  });
  it("canonicalizes the confirmed save revision without replacing a different remote conflict", () => {
    const state: DraftSession<string> = { sessionKey: "alice", baseline: { value: "submitted", revision: "saved" }, draft: "late input", remote: { value: "external", revision: "external" } };
    const next = receiveRemote(state, { value: "canonical", revision: "saved" }, equal);
    expect(next).toEqual({ sessionKey: "alice", baseline: { value: "canonical", revision: "saved" }, draft: "late input", remote: { value: "external", revision: "external" } });
    expect(receiveRemote(next, { value: "canonical", revision: "saved" }, equal)).toBe(next);
  });
});
