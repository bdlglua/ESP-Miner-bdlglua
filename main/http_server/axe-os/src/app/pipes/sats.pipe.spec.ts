import { SatsPipe } from './sats.pipe';

describe('SatsPipe', () => {
  it('create an instance', () => {
    const pipe = new SatsPipe();
    expect(pipe).toBeTruthy();
  });

  it('formats Bitcoin amounts from legacy firmware with eight decimals', () => {
    expect(SatsPipe.transform(5000000000)).toBe('50.00000000 BTC');
  });

  it('formats Peercoin atomic units with six decimals', () => {
    expect(SatsPipe.transform(38170000, {currency: 'PPC', decimals: 6})).toBe('38.170000 PPC');
    expect(SatsPipe.transform(1, {currency: 'PPC', decimals: 6})).toBe('0.000001 PPC');
  });
  it('formats DigiByte amounts with eight decimals', () => {
    expect(SatsPipe.transform(24516336428, {currency: 'DGB', decimals: 8})).toBe('245.16336428 DGB');
    expect(SatsPipe.transform(1, {currency: 'DGB', decimals: 8})).toBe('0.00000001 DGB');
  });

});
