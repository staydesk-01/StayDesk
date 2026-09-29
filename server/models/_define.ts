import mongoose, { model, type Schema } from "mongoose";

/** Registers a model once. Next.js dev hot-reload re-evaluates modules; re-registering would throw OverwriteModelError. */
export function defineModel<TSchema extends Schema>(name: string, schema: TSchema) {
  const create = () => model(name, schema);
  return (mongoose.models[name] ?? create()) as ReturnType<typeof create>;
}
