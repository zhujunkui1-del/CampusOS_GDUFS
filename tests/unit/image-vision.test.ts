import { describe, expect, it } from "vitest";
import {
  ImageVisionSchema,
  normalizeVisionFields,
  type ImageVision,
} from "@/domain/ingestion/image-vision";

function base(overrides: Partial<ImageVision> = {}): ImageVision {
  const field = (value: string | null, evidence: string | null) => ({
    value,
    evidence,
  });
  return {
    readable: true,
    text: "讲座预告 11月19日 凤鸣会堂",
    title: field("讲座预告", "讲座预告"),
    category: field("lecture", "讲座预告"),
    startsAt: field("11月19日", "11月19日"),
    endsAt: field("11月19日", "11月19日"),
    timeText: field("19:00", "19:00"),
    place: field("凤鸣会堂", "凤鸣会堂"),
    speaker: field("张三", "主讲人张三"),
    registration: field("扫码报名", "扫码报名"),
    deadline: field("11月18日", "11月18日截止"),
    organizer: field("学工部", "学工部"),
    summary: field("讲座预告", "讲座预告"),
    ...overrides,
  };
}

describe("image vision evidence rules", () => {
  it("drops fields whose value has no quoted evidence", () => {
    const normalized = normalizeVisionFields(
      base({
        startsAt: { value: "2026年11月19日", evidence: null },
        place: { value: "凤鸣会堂", evidence: null },
      }),
    );
    expect(normalized.startsAt).toEqual({ value: null, evidence: null });
    expect(normalized.place).toEqual({ value: null, evidence: null });
    expect(normalized.deadline?.value).toBe("11月18日");
  });

  it("clears all fields when the image is unreadable", () => {
    const normalized = normalizeVisionFields(
      base({ readable: false, text: "模糊" }),
    );
    expect(normalized.text).toBe("");
    for (const key of [
      "title",
      "category",
      "startsAt",
      "endsAt",
      "timeText",
      "place",
      "speaker",
      "registration",
      "deadline",
      "organizer",
      "summary",
    ] as const)
      expect(normalized[key]).toEqual({ value: null, evidence: null });
  });

  it("rejects a guessed field that does not match the strict schema", () => {
    expect(() =>
      ImageVisionSchema.parse({
        ...base(),
        startsAt: { value: "11月19日", evidence: "11月19日", confidence: 0.9 },
      }),
    ).toThrow();
  });
});
