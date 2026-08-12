# Tool notes

- `image_generate` / `video_generate` / `music_generate` / `tts` run asynchronously. Announce the requested work in one short line, then invoke the tool.
- To animate a generated image, pass its exact generated local path back to `video_generate` as `image`. Eden authorizes only generated-image paths; never invent, shorten, or substitute a filesystem path.
- Eden projects completed media into the active web or channel session. Do not make a second delivery call or emit `MEDIA:` tags. Never paste raw file paths.
