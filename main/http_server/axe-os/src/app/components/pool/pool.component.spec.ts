import {ComponentFixture, TestBed} from '@angular/core/testing';
import {firstValueFrom, of} from 'rxjs';
import {AppModule} from '../../app.module';
import {SystemInfo} from '../../generated';
import {SystemApiService} from '../../services/system.service';
import {PoolComponent} from './pool.component';

describe('Pool coin selection', () => {
  let service: SystemApiService;
  let info: SystemInfo;
  let fixture: ComponentFixture<PoolComponent>;

  beforeEach(async () => {
    TestBed.configureTestingModule({imports: [AppModule]});
    service = TestBed.inject(SystemApiService);
    info = await firstValueFrom(service.getInfo());
  });

  function create() {
    vi.spyOn(service, 'getInfo').mockReturnValue(of(info));
    fixture = TestBed.createComponent(PoolComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('defaults older firmware to Auto and sends independent numeric primary/fallback coins', () => {
    Reflect.deleteProperty(info, 'stratumCoin');
    Reflect.deleteProperty(info, 'fallbackStratumCoin');
    const component = create();
    expect(component.form.get('stratumCoin')?.value).toBe(0);
    expect(component.form.get('fallbackStratumCoin')?.value).toBe(0);
    component.form.patchValue({stratumCoin: 3, fallbackStratumCoin: 1});
    const save = vi.spyOn(service, 'updateSystem').mockReturnValue(of(null));
    component.updateSystem();
    expect(save).toHaveBeenCalledWith('', expect.objectContaining({stratumCoin: 3, fallbackStratumCoin: 1}));
    expect(save.mock.calls[0][1]).not.toHaveProperty('stratumPassword');
    expect(save.mock.calls[0][1]).not.toHaveProperty('fallbackStratumPassword');
  });

  it('preserves explicit DigiByte and Peercoin choices on load', () => {
    Object.assign(info, {stratumCoin: 3, fallbackStratumCoin: 2});
    const component = create();
    expect(component.form.get('stratumCoin')?.value).toBe(3);
    expect(component.form.get('fallbackStratumCoin')?.value).toBe(2);
    expect(component.form.pristine).toBe(true);
    expect(fixture.nativeElement.querySelectorAll('select[id$=Coin]')).toHaveLength(2);
  });

  it('rejects fractional and out-of-range coin choices', () => {
    const component = create();
    for (const value of [-1, 4, 2.5]) {
      component.form.get('stratumCoin')?.setValue(value);
      expect(component.form.get('stratumCoin')?.invalid).toBe(true);
    }
    component.form.get('stratumCoin')?.setValue(3);
    expect(component.form.get('stratumCoin')?.valid).toBe(true);
  });

  it('persists a named profile without a password and loads it into the chosen pool only', () => {
    const storageKey = `axeos.poolProfiles.v1.${info.macAddr}`;
    localStorage.removeItem(storageKey);
    const component = create();
    try {
      component.form.patchValue({stratumURL: 'pool.example', stratumPort: 4444, stratumCoin: 3, stratumPassword: 'private-test-value'});
      component.profileNames.stratum = 'DigiByte';
      component.saveProfile('stratum');
      const saved = JSON.parse(localStorage.getItem(storageKey)!);
      expect(saved).toHaveLength(1);
      expect(saved[0].settings).toMatchObject({URL: 'pool.example', Port: 4444, Coin: 3});
      expect(JSON.stringify(saved)).not.toContain('private-test-value');
      expect(saved[0].settings).not.toHaveProperty('Password');
      component.loadProfile('fallbackStratum', 'DigiByte');
      expect(component.form.value).toMatchObject({
        stratumPassword: 'private-test-value', fallbackStratumURL: 'pool.example',
        fallbackStratumPort: 4444, fallbackStratumCoin: 3, fallbackStratumPassword: ''
      });
      expect(component.form.get('fallbackStratumPassword')?.invalid).toBe(true);
      component.deleteProfile('DigiByte');
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual([]);
    } finally {
      localStorage.removeItem(storageKey);
    }
  });

  it('prefills zpool TLS for the selected role and requires a payout wallet before saving', () => {
    const c = create();
    const update = vi.spyOn(service, 'updateSystem');
    const primaryHost = c.form.get('stratumURL')?.value;
    c.useZpoolPreset('fallbackStratum');
    fixture.detectChanges();
    expect(c.form.get('stratumURL')?.value).toBe(primaryHost);
    expect(c.form.value).toMatchObject({
      fallbackStratumURL: 'sha256.eu.mine.zpool.ca', fallbackStratumPort: 53333,
      fallbackStratumTLS: 1, fallbackStratumUser: '', fallbackStratumPassword: 'c=BTC',
      fallbackStratumCoin: 0, fallbackStratumSuggestedDifficulty: 0
    });
    expect(c.form.invalid).toBe(true);
    expect(c.isZpool('fallbackStratum')).toBe(true);
    expect(update).not.toHaveBeenCalled();
    c.onUrlChange('fallbackStratum');
    expect(c.form.get('fallbackStratumTLS')?.value).toBe(1);
  });

});
