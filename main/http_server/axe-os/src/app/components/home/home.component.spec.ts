import { ComponentFixture, TestBed } from '@angular/core/testing';

import { HomeComponent } from './home.component';
import { AppModule } from '../../app.module';
import { SystemApiService } from '../../services/system.service';
import { SystemInfo } from '../../generated';
import { firstValueFrom, Observable, of, Subject, Subscriber, throwError } from 'rxjs';
import { UIChart } from '@openng/optimus-ui/chart';
import { LoadingService } from '../../services/loading.service';

describe('HomeComponent', () => {
  let component: HomeComponent;
  let fixture: ComponentFixture<HomeComponent>;
  let apiInfo: SystemInfo;
  let updates: Subject<SystemInfo>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [AppModule]
    });
    const systemService = TestBed.inject(SystemApiService);
    apiInfo = await firstValueFrom(systemService.getInfo());
    updates = new Subject<SystemInfo>();
    vi.spyOn(systemService, 'getInfo').mockReturnValue(updates);
    vi.spyOn(systemService, 'getStatistics').mockReturnValue(of({
      labels: [], statistics: [], currentTimestamp: 0
    }));
    // JSDOM has no canvas renderer. Keep the real dashboard template and controls.
    vi.spyOn(UIChart.prototype, 'initChart').mockImplementation(() => {});
    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    updates.complete();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function recreateComponent() {
    fixture.destroy();
    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should not crash when the pool omits coinbaseOutputs', () => {
    // Some non-Bitcoin Stratum jobs do not contain decodable coinbase outputs.
    const info = {coinbaseOutputs: undefined, version: '2.13.2', axeOSVersion: '2.13.2'} as any;
    const noError = {duration: 0, startTime: null};
    expect(() => component.handleSystemMessages(info, noError)).not.toThrow();
    expect(component.messages.some(m => m.type === 'NOT_SOLO_MINING' || m.type === 'NO_MINING_REWARD')).toBe(false);
  });

  it('should not crash when coinbaseOutputs is null', () => {
    const info = {coinbaseOutputs: null, version: '2.13.2', axeOSVersion: '2.13.2'} as any;
    expect(() => component.handleSystemMessages(info, {duration: 0, startTime: null})).not.toThrow();
  });

  for (const missingOutputs of [undefined, null]) {
    it(`should render live Peercoin data with coinbaseOutputs ${missingOutputs}`, () => {
      const info = { ...apiInfo };
      if (missingOutputs === undefined) {
        Reflect.deleteProperty(info, 'coinbaseOutputs');
      } else {
        Object.assign(info, { coinbaseOutputs: null });
      }

      updates.next(info);
      fixture.detectChanges();

      expect(info.coinbaseOutputs).toEqual([]);
      expect(fixture.nativeElement.textContent).toContain('Hashrate');
      expect(fixture.nativeElement.textContent).toContain('Block Header');
      expect(component.messages.some(m => m.type === 'NOT_SOLO_MINING' || m.type === 'NO_MINING_REWARD')).toBe(false);
    });
  }

  it('should clear Bitcoin payout warnings when subsequent Peercoin jobs omit outputs', () => {
    updates.next({ ...apiInfo, coinbaseValueUserSatoshis: 0 });
    expect(component.messages.some(m => m.type === 'NO_MINING_REWARD')).toBe(true);

    const info = { ...apiInfo };
    Reflect.deleteProperty(info, 'coinbaseOutputs');
    updates.next(info);
    fixture.detectChanges();

    expect(component.messages.some(m => m.type === 'NOT_SOLO_MINING' || m.type === 'NO_MINING_REWARD')).toBe(false);
  });

  it('should preserve decoded Bitcoin outputs', () => {
    updates.next({ ...apiInfo });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('payo');
    expect(apiInfo.coinbaseOutputs).toEqual([{ value: 50, address: 'payoutaddress' }]);
  });

  for (const missingValue of [undefined, null]) {
    it(`should explain block details that are ${missingValue}`, () => {
      const info = { ...apiInfo };
      for (const key of ['blockHeight', 'networkDifficulty', 'scriptsig', 'coinbaseOutputs', 'coinbaseValueTotalSatoshis']) {
        if (missingValue === undefined) {
          Reflect.deleteProperty(info, key);
        } else {
          Object.assign(info, { [key]: null });
        }
      }
      updates.next(info);
      fixture.detectChanges();

      const blockCard: HTMLElement = fixture.nativeElement.querySelector('[data-testid="block-header"]');
      expect(blockCard.textContent).toContain('Block details unavailable.');
      expect(blockCard.textContent).not.toContain('Height');
      expect(fixture.nativeElement.textContent).toContain('Hashrate');
    });
  }

  it('should display available block fields with placeholders for missing fields', () => {
    const info = { ...apiInfo, blockHeight: 123456, coinbaseOutputs: [] };
    for (const key of ['networkDifficulty', 'scriptsig', 'coinbaseValueTotalSatoshis']) {
      Reflect.deleteProperty(info, key);
    }
    updates.next(info);
    fixture.detectChanges();

    const blockCard: HTMLElement = fixture.nativeElement.querySelector('[data-testid="block-header"]');
    expect(blockCard.textContent).toContain('123456');
    expect(blockCard.textContent).toContain('--');
    expect(blockCard.textContent).not.toContain('Block details unavailable.');
  });

  it('should preserve a known zero coinbase amount', () => {
    updates.next({ ...apiInfo, blockHeight: 0, networkDifficulty: 0, scriptsig: '',
      coinbaseOutputs: [], coinbaseValueTotalSatoshis: 0 });
    fixture.detectChanges();

    const blockCard: HTMLElement = fixture.nativeElement.querySelector('[data-testid="block-header"]');
    expect(blockCard.textContent).toMatch(/Amount\s+0/);
    expect(blockCard.textContent).not.toContain('Block details unavailable.');
  });

  it('should display decoded Peercoin block data without Bitcoin solo payout warnings', () => {
    // Seed a Bitcoin-only warning to cover switching pools as well.
    updates.next({ ...apiInfo, coinbaseValueUserSatoshis: 0 });
    expect(component.messages.some(m => m.type === 'NO_MINING_REWARD')).toBe(true);
    updates.next({ ...apiInfo, blockHeight: 901555, scriptsig: '/BCMonster/',
      coinbaseCurrency: 'PPC', coinbaseDecimals: 6,
      coinbaseOutputs: [{value: 38170000, address: 'pool-payout'}],
      coinbaseValueTotalSatoshis: 38170000, coinbaseValueUserSatoshis: 0 });
    fixture.detectChanges();

    const blockCard: HTMLElement = fixture.nativeElement.querySelector('[data-testid="block-header"]');
    expect(blockCard.textContent).toContain('901555');
    expect(blockCard.textContent).toContain('/BCMonster/');
    expect(blockCard.textContent).toContain('38.170000 PPC');
    expect(blockCard.textContent).not.toContain('BTC');
    expect(component.messages.some(m => m.type === 'NOT_SOLO_MINING' || m.type === 'NO_MINING_REWARD')).toBe(false);
  });

  it('shows DigiByte rewards with eight decimals and clears Bitcoin payout warnings', () => {
    updates.next({...apiInfo, coinbaseValueUserSatoshis: 0});
    expect(component.messages.some(m => m.type === 'NO_MINING_REWARD')).toBe(true);
    updates.next({...apiInfo, blockHeight: 24579117, scriptsig: '/BCMonster/',
      coinbaseCurrency: 'DGB', coinbaseDecimals: 8,
      coinbaseOutputs: [{value: 24516336428, address: 'dgb1-pool-payout'}],
      coinbaseValueTotalSatoshis: 24516336428, coinbaseValueUserSatoshis: 0});
    fixture.detectChanges();
    const blockCard: HTMLElement = fixture.nativeElement.querySelector('[data-testid="block-header"]');
    expect(blockCard.textContent).toContain('245.16336428 DGB');
    expect(blockCard.textContent).not.toContain('BTC');
    expect(component.messages.some(m => m.type === 'NOT_SOLO_MINING' || m.type === 'NO_MINING_REWARD')).toBe(false);
  });

  it('hides solo payouts only while the active pool is zpool', () => {
    const info = {...apiInfo, fallbackStratumURL: 'sha256.eu.mine.zpool.ca',
      coinbaseCurrency: 'BTC', coinbaseValueUserSatoshis: 0};
    updates.next({...info, isUsingFallbackStratum: 0});
    expect(component.messages.some(m => m.type === 'NO_MINING_REWARD')).toBe(true);
    updates.next({...info, isUsingFallbackStratum: 1});
    fixture.detectChanges();
    expect(component.messages.some(m => m.type === 'NO_MINING_REWARD')).toBe(false);
    const blockCard = fixture.nativeElement.querySelector('[data-testid="block-header"]');
    expect(blockCard.textContent).toContain('zpool switches between SHA-256 chains');
    expect(blockCard.textContent).not.toContain('BTC');
  });

  it('renders the current zpool job header with no inferred payout currency', () => {
    const zpoolInfo = {
      ...apiInfo,
      stratumURL: 'sha256.eu.mine.zpool.ca',
      zpoolJobHeader: {
        height: 24759621, difficulty: 166453683, jobId: '633dd',
        previousBlockHash: '000000000000000933332222111100000000aaaa33332222111100000000cccc',
        version: '20000202', bits: '19095c6e', timestamp: 1794952210
      }
    };
    updates.next(zpoolInfo);
    fixture.detectChanges();
    const card: HTMLElement = fixture.nativeElement.querySelector('[data-testid="block-header"]');
    for (const value of ['24,759,621', '166.45 M', '633dd', '0x20000202', '0x19095c6e',
                         zpoolInfo.zpoolJobHeader.previousBlockHash, 'UTC']) {
      expect(card.textContent).toContain(value);
    }
    expect(card.textContent).not.toContain('Amount');
    updates.next({...zpoolInfo, zpoolJobHeader: {...zpoolInfo.zpoolJobHeader, height: undefined}});
    fixture.detectChanges();
    expect(card.textContent).not.toContain('Height');
    updates.next({...zpoolInfo, zpoolJobHeader: undefined, networkDifficulty: 0});
    fixture.detectChanges();
    expect(card.textContent).toContain('Waiting for a zpool job.');
    expect(card.textContent).not.toContain('633dd');
  });

  it('cancels a pending first live request when leaving the dashboard', () => {
    const cancel = vi.fn();
    vi.mocked(TestBed.inject(SystemApiService).getInfo).mockReturnValue(new Observable(() => cancel));
    recreateComponent();
    expect(TestBed.inject(LoadingService).loading$.value).toBe(true);
    fixture.destroy();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(LoadingService).loading$.value).toBe(false);
  });

  it('stops retrying failed live requests after the dashboard is destroyed', () => {
    vi.useFakeTimers();
    const getInfo = vi.mocked(TestBed.inject(SystemApiService).getInfo);
    getInfo.mockClear().mockImplementation(() => throwError(() => new Error('offline')));
    recreateComponent();
    vi.advanceTimersByTime(5000);
    expect(getInfo).toHaveBeenCalledTimes(2);
    fixture.destroy();
    vi.advanceTimersByTime(15000);
    expect(getInfo).toHaveBeenCalledTimes(2);
    expect(TestBed.inject(LoadingService).loading$.value).toBe(false);
  });

  it('stops normal polling after a successful response when leaving the dashboard', () => {
    vi.useFakeTimers();
    const getInfo = vi.mocked(TestBed.inject(SystemApiService).getInfo);
    getInfo.mockClear().mockImplementation(() => of({ ...apiInfo }));
    recreateComponent();
    vi.advanceTimersByTime(5000);
    expect(getInfo).toHaveBeenCalledTimes(2);
    fixture.destroy();
    vi.advanceTimersByTime(15000);
    expect(getInfo).toHaveBeenCalledTimes(2);
  });

  it('cancels pending history without starting live requests after navigation', () => {
    const cancel = vi.fn();
    const system = TestBed.inject(SystemApiService);
    vi.mocked(system.getStatistics).mockReturnValue(new Observable(() => cancel));
    vi.mocked(system.getInfo).mockClear();
    recreateComponent();
    expect(system.getInfo).not.toHaveBeenCalled();
    fixture.destroy();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(LoadingService).loading$.value).toBe(false);
  });

  it('keeps live monitoring available when the history request fails', () => {
    vi.mocked(TestBed.inject(SystemApiService).getStatistics)
      .mockReturnValue(throwError(() => new Error('history unavailable')));
    recreateComponent();
    updates.next({ ...apiInfo });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Hashrate');
    expect(TestBed.inject(LoadingService).loading$.value).toBe(false);
  });

  it('replaces the previous live request when chart sources are reloaded', () => {
    let activeRequests = 0;
    const requests: Subscriber<SystemInfo>[] = [];
    const system = TestBed.inject(SystemApiService);
    vi.mocked(system.getInfo).mockImplementation(() => new Observable(subscriber => {
      activeRequests++;
      requests.push(subscriber);
      return () => { activeRequests--; };
    }));
    vi.spyOn(system, 'updateSystem').mockReturnValue(of({}));
    recreateComponent();
    requests[0].next({ ...apiInfo });
    component.updateSystem();
    expect(requests).toHaveLength(2);
    expect(activeRequests).toBe(1);
    requests[1].next({ ...apiInfo });
    expect(TestBed.inject(LoadingService).loading$.value).toBe(false);
    fixture.destroy();
    expect(activeRequests).toBe(0);
  });
});
