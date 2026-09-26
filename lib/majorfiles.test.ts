import { describe, expect, it } from 'vitest';
import { MAJOR_MAX, pickMajorFiles } from './majorfiles';

const f = (path: string, size = 100) => ({ path, size });

describe('pickMajorFiles', () => {
  it('always includes docs when present, first of each kind', () => {
    const plan = pickMajorFiles(
      [f('AGENTS.md'), f('docs/AGENTS.md'), f('CLAUDE.md'), f('README.md'), f('src/a.ts')],
      [],
    );
    expect(plan.docFiles).toEqual(['AGENTS.md', 'CLAUDE.md', 'README.md']);
    expect(plan.files.map((x) => x.path)).toContain('AGENTS.md');
    expect(plan.files.map((x) => x.path)).not.toContain('docs/AGENTS.md');
  });

  it('ranks by inbound import degree, code-point ties', () => {
    const files = [f('a.ts'), f('b.ts'), f('c.ts'), f('d.ts')];
    // c is imported by a, b, d → degree 3; a by nobody
    const edges: Array<[string, string]> = [
      ['a.ts', 'c.ts'],
      ['b.ts', 'c.ts'],
      ['d.ts', 'c.ts'],
      ['a.ts', 'b.ts'],
    ];
    const plan = pickMajorFiles(files, edges);
    const paths = plan.files.map((x) => x.path);
    expect(paths.indexOf('c.ts')).toBeLessThan(paths.indexOf('a.ts'));
  });

  it('skips and counts secret files', () => {
    const plan = pickMajorFiles([f('.env'), f('README.md'), f('a.ts')], []);
    expect(plan.skippedSecret).toBe(1);
    expect(plan.files.map((x) => x.path)).not.toContain('.env');
  });

  it('skips and counts oversize and non-text files', () => {
    const plan = pickMajorFiles(
      [f('big.ts', 200 * 1024), f('img.png'), f('README.md')],
      [],
    );
    expect(plan.skippedBig).toBe(1);
    expect(plan.skippedExt).toBe(1);
    expect(plan.files.map((x) => x.path)).toEqual(['README.md']);
  });

  it('caps at MAJOR_MAX, lowest-ranked cut counted', () => {
    const files = Array.from({ length: 40 }, (_, i) => f(`f${String(i).padStart(2, '0')}.ts`));
    const plan = pickMajorFiles(files, []);
    expect(plan.files.length).toBe(MAJOR_MAX);
    expect(plan.cutByCap).toBe(40 - MAJOR_MAX);
  });

  it('resolves package.json entry points against the build set', () => {
    const pkg = JSON.stringify({ main: './dist/index.js', scripts: { dev: 'tsx src/start.ts' } });
    const plan = pickMajorFiles(
      [f('package.json'), f('dist/index.js'), f('src/start.ts'), f('README.md')],
      [],
      pkg,
    );
    const paths = plan.files.map((x) => x.path);
    expect(paths).toContain('src/start.ts');
    expect(paths).toContain('dist/index.js');
  });

  it('is deterministic: same input, same output', () => {
    const files = [f('b.ts'), f('a.ts'), f('README.md')];
    const edges: Array<[string, string]> = [['b.ts', 'a.ts']];
    expect(pickMajorFiles(files, edges)).toEqual(pickMajorFiles(files, edges));
  });
});
