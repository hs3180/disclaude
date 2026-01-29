/**
 * Tests for file extension preservation in file-downloader
 */

import { describe, it, expect } from 'vitest';
import { extractFileExtension } from './file-downloader.js';

describe('extractFileExtension', () => {
  it('should extract .jpg extension from filename', () => {
    expect(extractFileExtension('photo.jpg')).toBe('.jpg');
    expect(extractFileExtension('image.jpg')).toBe('.jpg');
    expect(extractFileExtension('my.photo.jpg')).toBe('.jpg');
  });

  it('should extract .png extension from filename', () => {
    expect(extractFileExtension('screenshot.png')).toBe('.png');
    expect(extractFileExtension('diagram.png')).toBe('.png');
  });

  it('should extract .gif extension from filename', () => {
    expect(extractFileExtension('animation.gif')).toBe('.gif');
  });

  it('should extract .pdf extension from filename', () => {
    expect(extractFileExtension('document.pdf')).toBe('.pdf');
  });

  it('should return empty string when no extension', () => {
    expect(extractFileExtension('noextension')).toBe('');
    expect(extractFileExtension('file')).toBe('');
    expect(extractFileExtension('image_img_v3_0')).toBe('');
  });

  it('should handle empty string', () => {
    expect(extractFileExtension('')).toBe('');
  });

  it('should handle multiple dots correctly', () => {
    expect(extractFileExtension('my.file.name.jpg')).toBe('.jpg');
    expect(extractFileExtension('archive.tar.gz')).toBe('.gz');
  });

  it('should handle uppercase extensions (normalized to lowercase)', () => {
    expect(extractFileExtension('photo.JPG')).toBe('.jpg');
    expect(extractFileExtension('photo.Png')).toBe('.png');
  });

  it('should return default extension for image type when no extension', () => {
    expect(extractFileExtension('image_img_v3_0', 'image')).toBe('.jpg');
    expect(extractFileExtension('noextension', 'file')).toBe('.bin');
  });

  it('should prioritize actual extension over default', () => {
    expect(extractFileExtension('photo.png', 'image')).toBe('.png');
    expect(extractFileExtension('document.pdf', 'file')).toBe('.pdf');
  });
});
