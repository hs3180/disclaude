/**
 * Passive Mode Manager Tests.
 *
 * Issue #2052: File-based persistence + small group auto-detection.
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, beforeEach, afterEach } from 'vitest';
import { expect } from 'chai';
import { PassiveModeManager } from './passive-mode.js';

describe('PassiveModeManager', () => {
  describe('In-memory mode (no configPath)', () => {
    let manager: PassiveModeManager;

    beforeEach(() => {
      manager = new PassiveModeManager();
    });

    it('should start with no disabled chats', () => {
      expect(manager.isPassiveModeDisabled('oc_test')).to.be.false;
      expect(manager.getPassiveModeDisabledChats()).to.deep.equal([]);
    });

    it('should disable passive mode for a chat', () => {
      manager.setPassiveModeDisabled('oc_test', true);
      expect(manager.isPassiveModeDisabled('oc_test')).to.be.true;
      expect(manager.getPassiveModeDisabledChats()).to.deep.equal(['oc_test']);
    });

    it('should re-enable passive mode for a chat', () => {
      manager.setPassiveModeDisabled('oc_test', true);
      manager.setPassiveModeDisabled('oc_test', false);
      expect(manager.isPassiveModeDisabled('oc_test')).to.be.false;
      expect(manager.getPassiveModeDisabledChats()).to.deep.equal([]);
    });

    it('should handle multiple chats independently', () => {
      manager.setPassiveModeDisabled('oc_chat1', true);
      manager.setPassiveModeDisabled('oc_chat2', true);
      expect(manager.getPassiveModeDisabledChats()).to.have.length(2);

      manager.setPassiveModeDisabled('oc_chat1', false);
      expect(manager.isPassiveModeDisabled('oc_chat1')).to.be.false;
      expect(manager.isPassiveModeDisabled('oc_chat2')).to.be.true;
    });

    describe('Small group detection tracking', () => {
      it('should start with no checked chats', () => {
        expect(manager.isSmallGroupChecked('oc_test')).to.be.false;
      });

      it('should mark a chat as checked', () => {
        manager.markSmallGroupChecked('oc_test');
        expect(manager.isSmallGroupChecked('oc_test')).to.be.true;
      });

      it('should handle multiple checked chats', () => {
        manager.markSmallGroupChecked('oc_chat1');
        manager.markSmallGroupChecked('oc_chat2');
        expect(manager.isSmallGroupChecked('oc_chat1')).to.be.true;
        expect(manager.isSmallGroupChecked('oc_chat2')).to.be.true;
        expect(manager.isSmallGroupChecked('oc_chat3')).to.be.false;
      });
    });
  });

  describe('File-based persistence', () => {
    let tempDir: string;
    let configPath: string;
    let manager: PassiveModeManager;

    beforeEach(async () => {
      tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'passive-mode-test-'));
      configPath = path.join(tempDir, 'passive-mode.json');
    });

    afterEach(async () => {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    });

    it('should create state file on first setPassiveModeDisabled', async () => {
      manager = new PassiveModeManager({ configPath });
      await manager.init();

      manager.setPassiveModeDisabled('oc_test', true);

      // Wait for fire-and-forget persistence
      await new Promise(resolve => setTimeout(resolve, 100));

      const content = await fsPromises.readFile(configPath, 'utf-8');
      const state = JSON.parse(content);
      expect(state.disabledChats['oc_test']).to.be.true;
    });

    it('should load existing state from file on init', async () => {
      // Pre-create state file
      const initialState = {
        disabledChats: { oc_existing: true, oc_another: true },
        smallGroupChecked: ['oc_checked1'],
      };
      await fsPromises.writeFile(configPath, JSON.stringify(initialState, null, 2));

      manager = new PassiveModeManager({ configPath });
      await manager.init();

      expect(manager.isPassiveModeDisabled('oc_existing')).to.be.true;
      expect(manager.isPassiveModeDisabled('oc_another')).to.be.true;
      expect(manager.isPassiveModeDisabled('oc_notdisabled')).to.be.false;
      expect(manager.isSmallGroupChecked('oc_checked1')).to.be.true;
      expect(manager.isSmallGroupChecked('oc_notchecked')).to.be.false;
    });

    it('should persist smallGroupChecked state', async () => {
      manager = new PassiveModeManager({ configPath });
      await manager.init();

      manager.markSmallGroupChecked('oc_test');

      // Wait for fire-and-forget persistence
      await new Promise(resolve => setTimeout(resolve, 100));

      const content = await fsPromises.readFile(configPath, 'utf-8');
      const state = JSON.parse(content);
      expect(state.smallGroupChecked).to.include('oc_test');
    });

    it('should persist both disabledChats and smallGroupChecked together', async () => {
      manager = new PassiveModeManager({ configPath });
      await manager.init();

      manager.setPassiveModeDisabled('oc_chat1', true);
      manager.markSmallGroupChecked('oc_chat1');
      manager.markSmallGroupChecked('oc_chat2');

      // Wait for fire-and-forget persistence
      await new Promise(resolve => setTimeout(resolve, 200));

      // Create new manager and verify state is loaded
      const manager2 = new PassiveModeManager({ configPath });
      await manager2.init();

      expect(manager2.isPassiveModeDisabled('oc_chat1')).to.be.true;
      expect(manager2.isSmallGroupChecked('oc_chat1')).to.be.true;
      expect(manager2.isSmallGroupChecked('oc_chat2')).to.be.true;
    });

    it('should handle missing file gracefully', async () => {
      manager = new PassiveModeManager({ configPath });
      await manager.init();

      expect(manager.isPassiveModeDisabled('oc_test')).to.be.false;
      expect(manager.isSmallGroupChecked('oc_test')).to.be.false;
    });

    it('should handle corrupted file gracefully', async () => {
      await fsPromises.writeFile(configPath, 'not valid json{{{');

      manager = new PassiveModeManager({ configPath });
      await manager.init();

      // Should not crash, starts with empty state
      expect(manager.isPassiveModeDisabled('oc_test')).to.be.false;
    });

    it('should persist disabled=false (removal) correctly', async () => {
      // Start with a disabled chat
      const initialState = {
        disabledChats: { oc_test: true },
        smallGroupChecked: [],
      };
      await fsPromises.writeFile(configPath, JSON.stringify(initialState, null, 2));

      manager = new PassiveModeManager({ configPath });
      await manager.init();

      expect(manager.isPassiveModeDisabled('oc_test')).to.be.true;

      // Re-enable passive mode
      manager.setPassiveModeDisabled('oc_test', false);

      // Wait for fire-and-forget persistence
      await new Promise(resolve => setTimeout(resolve, 100));

      const content = await fsPromises.readFile(configPath, 'utf-8');
      const state = JSON.parse(content);
      expect(state.disabledChats['oc_test']).to.be.undefined;
    });

    it('should work without configPath (backward compatible)', async () => {
      manager = new PassiveModeManager();
      await manager.init();

      manager.setPassiveModeDisabled('oc_test', true);
      expect(manager.isPassiveModeDisabled('oc_test')).to.be.true;

      // No file should be created
      // (we can't easily verify this without checking the filesystem,
      // but the key point is it doesn't crash)
    });
  });
});
