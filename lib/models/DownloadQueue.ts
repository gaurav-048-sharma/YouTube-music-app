import mongoose, { Schema, Document, Model } from "mongoose";

export interface IDownloadQueue extends Document {
  videoId: string;
  title: string;
  thumbnail: string;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
  requestedAt: Date;
  completedAt?: Date;
}

const DownloadQueueSchema = new Schema<IDownloadQueue>(
  {
    videoId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    thumbnail: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      index: true,
    },
    error: { type: String },
    requestedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

export const DownloadQueue: Model<IDownloadQueue> =
  mongoose.models.DownloadQueue ||
  mongoose.model<IDownloadQueue>("DownloadQueue", DownloadQueueSchema);
