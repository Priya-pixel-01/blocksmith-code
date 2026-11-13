import { mkdirSync } from "node:fs";
import { resolve, extname } from "node:path";
import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { env } from "../env.js";

export const uploadsRouter = Router();

const uploadsDir = resolve(env.uploadsDir);
mkdirSync(uploadsDir, { recursive: true });

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (_req, file, cb) => cb(null, `${nanoid(12)}${extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: image (png/jpeg/webp/gif) or PDF.`));
      return;
    }
    cb(null, true);
  },
});

/** Accepts one image or PDF file, returns a server-side path the client references in a batch source. */
uploadsRouter.post("/uploads", upload.single("file"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
    return;
  }
  const kind = req.file.mimetype === "application/pdf" ? "pdf" : "image";
  res.json({ path: req.file.path, kind, originalName: req.file.originalname });
});
