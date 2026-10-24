// شكل الرد المطلوب من أي مزوّد ذكاء اصطناعي (JSON Schema) - وبنتأكد منه تاني بـ zod
export const COPY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } },
        required: ["text", "hashtags"],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
};
