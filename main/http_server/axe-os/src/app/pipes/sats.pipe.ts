import { Pipe, PipeTransform } from '@angular/core';

interface CoinAmountFormat {
  currency?: string;
  decimals?: number;
}

@Pipe({
  standalone: false,
  name: 'sats',
  pure: true
})
export class SatsPipe implements PipeTransform {
  private static _this = new SatsPipe();

  public static transform(value: number, args?: CoinAmountFormat): string {
    return this._this.transform(value, args);
  }

  transform(value: number, args?: CoinAmountFormat): string {
    const currency = args?.currency || 'BTC';
    const requestedDecimals = args?.decimals ?? (currency === 'PPC' ? 6 : 8);
    const decimals = Number.isInteger(requestedDecimals) && requestedDecimals >= 0 && requestedDecimals <= 8
      ? requestedDecimals : 8;
    if (!value) return `0 ${currency}`;
    return (value / 10 ** decimals).toFixed(decimals) + ` ${currency}`;
  }
}
