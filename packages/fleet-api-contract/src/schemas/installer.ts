import { z } from 'zod';

/** Installer -- latest agent build per OS (GET /installers). */
export const InstallerSchema = z.object({
  os: z.string().min(1),
  arch: z.string().min(1),
  file: z.string().min(1),
  cmd: z.string().min(1).describe('One-line install command'),
});
export type Installer = z.infer<typeof InstallerSchema>;
