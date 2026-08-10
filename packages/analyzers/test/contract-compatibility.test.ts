import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyContractCompatibility } from "../src/index.js";

test("classifies unchanged and additive optional signatures as compatible", () => {
  assert.equal(
    classifyContractCompatibility(
      "export function calculate(value: number): number",
      "export function calculate(value: number, tax?: number): number",
    ),
    "compatible",
  );
});

test("classifies renamed positional parameters with unchanged semantics as compatible", () => {
  assert.equal(
    classifyContractCompatibility(
      "export function calculate(value: number, precision?: number): number",
      "export function calculate(input: number, digits?: number): number",
    ),
    "compatible",
  );
  assert.equal(
    classifyContractCompatibility(
      "export function calculate(value: number, ...weights: number[]): number",
      "export function calculate(input: number, ...factors: number[]): number",
    ),
    "compatible",
  );
});

test("classifies removed and incompatible signatures as breaking", () => {
  assert.equal(
    classifyContractCompatibility(
      "export function calculate(value: number): number",
      "export function calculate(value: string): number",
    ),
    "breaking",
  );
  assert.equal(
    classifyContractCompatibility(
      "export function calculate(value: number, ...weights: number[]): number",
      "export function calculate(value: number, weights?: number[]): number",
    ),
    "breaking",
  );
  assert.equal(
    classifyContractCompatibility(
      "export function calculate(value: number): number",
      "",
    ),
    "breaking",
  );
});

test("returns unknown when a signature cannot be classified safely", () => {
  assert.equal(
    classifyContractCompatibility("export const calculate = (value: number) => value", "not a declaration"),
    "unknown",
  );
  assert.equal(
    classifyContractCompatibility("export interface Account", "export interface Account"),
    "unknown",
  );
});
