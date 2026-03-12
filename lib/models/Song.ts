import mongoose, { Schema, Document, Model } from "mongoose";

export interface ISong extends Document {
  videoId: string;
  title: string;
  cloudinaryUrl: string;
  cloudinaryPublicId: string;
  ext: string;
  fileSize: number;
  createdAt: Date;
  updatedAt: Date;
}

const SongSchema = new Schema<ISong>(
  {
    videoId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    cloudinaryUrl: { type: String, required: true },
    cloudinaryPublicId: { type: String, required: true },
    ext: { type: String, required: true },
    fileSize: { type: Number, required: true },
  },
  { timestamps: true }
);

export const Song: Model<ISong> =
  mongoose.models.Song || mongoose.model<ISong>("Song", SongSchema);
