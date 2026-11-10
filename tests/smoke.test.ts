import { describe, expect, it } from 'vitest';
import { TIME_ZONE } from '../src/lib/time';

describe('scaffold', () => {
  it('pins the time zone to Monterrey', () => {
    expect(TIME_ZONE).toBe('America/Monterrey');
  });
});
