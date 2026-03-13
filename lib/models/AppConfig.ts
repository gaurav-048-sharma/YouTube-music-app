import mongoose from "mongoose";

const AppConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true, collection: "app_config" }
);

export const AppConfig =
  mongoose.models.AppConfig || mongoose.model("AppConfig", AppConfigSchema);
