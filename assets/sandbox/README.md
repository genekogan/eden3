# Eden3 shared sandbox assets

This tree is mounted at `/shared-assets` inside every agent sandbox, read-only.
It is reserved for reviewed, non-secret assets used by curated skills, such as
film references and Little Martians character images.

Do not place credentials, private user files, generated media, or mutable agent
state here. Agents write their own artifacts to `/workspace`.
