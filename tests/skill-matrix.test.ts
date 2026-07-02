import { describe, it, expect } from 'vitest';
import { getRequiredSkills } from '../src/utils/skill-matrix.js';

describe('getRequiredSkills -- skill matrix utility', () => {
  // ------------------------------------------------------------------ no-tags
  describe('members with no tags', () => {
    it('returns empty array for no tags + GitHub', () => {
      expect(getRequiredSkills([], 'github')).toEqual([]);
    });

    it('returns empty array for no tags + Bitbucket', () => {
      expect(getRequiredSkills([], 'bitbucket')).toEqual([]);
    });

    it('returns empty array for no tags + AzDevOps', () => {
      expect(getRequiredSkills([], 'azdevops')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- bitbucket
  describe('Bitbucket VCS', () => {
    it('tags:["devops"] + VCS=bitbucket resolves to bitbucket-devops', () => {
      expect(getRequiredSkills(['devops'], 'bitbucket')).toEqual(['bitbucket-devops']);
    });

    it('tags:["code-review"] + VCS=bitbucket resolves to bitbucket-devops', () => {
      expect(getRequiredSkills(['code-review'], 'bitbucket')).toEqual(['bitbucket-devops']);
    });

    it('tags:["devops","code-review"] + VCS=bitbucket deduplicates to single skill', () => {
      expect(getRequiredSkills(['devops', 'code-review'], 'bitbucket')).toEqual(['bitbucket-devops']);
    });

    it('tags:["development"] + VCS=bitbucket needs no skills', () => {
      expect(getRequiredSkills(['development'], 'bitbucket')).toEqual([]);
    });

    it('tags:["testing"] + VCS=bitbucket needs no skills', () => {
      expect(getRequiredSkills(['testing'], 'bitbucket')).toEqual([]);
    });

    it('tags:["debugging"] + VCS=bitbucket needs no skills', () => {
      expect(getRequiredSkills(['debugging'], 'bitbucket')).toEqual([]);
    });
  });

  // ------------------------------------------------------------------- github
  describe('GitHub VCS', () => {
    it('tags:["devops"] + VCS=github needs no skills', () => {
      expect(getRequiredSkills(['devops'], 'github')).toEqual([]);
    });

    it('tags:["code-review"] + VCS=github needs no skills', () => {
      expect(getRequiredSkills(['code-review'], 'github')).toEqual([]);
    });
  });

  // --------------------------------------------------------------- azdevops
  describe('Azure DevOps VCS', () => {
    it('tags:["devops"] + VCS=azdevops resolves to azdevops-devops', () => {
      expect(getRequiredSkills(['devops'], 'azdevops')).toEqual(['azdevops-devops']);
    });

    it('tags:["code-review"] + VCS=azdevops resolves to azdevops-devops', () => {
      expect(getRequiredSkills(['code-review'], 'azdevops')).toEqual(['azdevops-devops']);
    });
  });

  // -------------------------------------------------------- project-specific
  describe('project-specific skills', () => {
    it('tags:["devops"] + project=ApraPipes adds aprapipes-devops', () => {
      expect(getRequiredSkills(['devops'], 'github', 'ApraPipes')).toEqual(['aprapipes-devops']);
    });

    it('tags:["debugging"] + project=StreamSurv AVMS adds lvsm-log-analyzer-skill', () => {
      expect(getRequiredSkills(['debugging'], 'github', 'StreamSurv AVMS')).toEqual(['lvsm-log-analyzer-skill']);
    });

    it('tags:["devops"] + project=ApraPipes + VCS=bitbucket adds both skills', () => {
      const skills = getRequiredSkills(['devops'], 'bitbucket', 'ApraPipes');
      expect(skills).toContain('bitbucket-devops');
      expect(skills).toContain('aprapipes-devops');
    });
  });

  // ----------------------------------------------------------------- casing
  describe('tag casing', () => {
    it('treats tag "Devops" same as "devops"', () => {
      expect(getRequiredSkills(['Devops'], 'bitbucket')).toEqual(['bitbucket-devops']);
    });

    it('treats VCS "Bitbucket" same as "bitbucket"', () => {
      expect(getRequiredSkills(['devops'], 'Bitbucket')).toEqual(['bitbucket-devops']);
    });
  });
});
