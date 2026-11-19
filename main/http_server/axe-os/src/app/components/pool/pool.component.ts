import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, Input, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ValidatorFn, ValidationErrors, AbstractControl } from '@angular/forms';
import { catchError, exhaustMap, Observable, of, timer } from 'rxjs';
import { isZpoolSha256 } from 'src/app/services/pool-hosts';
import { PoolStatistics } from 'src/app/services/miner-diagnostics';
import { PoolProfile, PoolSettings, PROFILE_LIMIT, poolProfile, readPoolProfiles } from './pool-profiles';
import { ToastrService } from '@openng/ngx-toastr';
import { LoadingService } from 'src/app/services/loading.service';
import { SystemApiService } from 'src/app/services/system.service';

type PoolType = 'stratum' | 'fallbackStratum';

interface ITlsOption {
  value: number;
  label: string;
}

@Component({
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
  selector: 'app-pool',
  templateUrl: './pool.component.html',
  styleUrl: './pool.component.scss'
})
export class PoolComponent implements OnInit {
  public form!: FormGroup;
  public savedChanges: boolean = false;

  public profiles: PoolProfile[] = [];
  public selectedProfiles = {stratum: '', fallbackStratum: ''};
  public profileNames = {stratum: '', fallbackStratum: ''};
  public stats$!: Observable<PoolStatistics | null>;
  public readonly poolRoles = ['primary', 'fallback'] as const;
  private profileStorageKey = '';

  public readonly DEFAULT_BITCOIN_ADDRESS = 'bc1qnp980s5fpp8l94p5cvttmtdqy8rvrq74qly2yrfmzkdsntqzlc5qkc4rkq';

  public pools: PoolType[] = ['stratum', 'fallbackStratum'];
  public showPassword = { 'stratum': false, 'fallbackStratum': false };
  public showAdvancedOptions = { 'stratum': false, 'fallbackStratum': false };

  public readonly coinOptions = [
    {value: 0, label: 'Auto (payout address)'},
    {value: 1, label: 'Bitcoin (BTC)'},
    {value: 2, label: 'Peercoin (PPC)'},
    {value: 3, label: 'DigiByte (DGB, SHA-256d)'}
  ];

  public tlsOptions: ITlsOption[] = [
    { value: 0, label: 'No TLS' },
    { value: 1, label: 'TLS (System certificate)' },
    { value: 2, label: 'TLS (Custom CA certificate)' }
  ];

  @Input() uri = '';

  constructor(
    private fb: FormBuilder,
    private systemService: SystemApiService,
    private toastr: ToastrService,
    private loadingService: LoadingService
  ) { }

  ngOnInit(): void {
    this.stats$ = timer(0, 10000).pipe(
      exhaustMap(() => this.systemService.getPoolStatistics(this.uri).pipe(catchError(() => of(null))))
    );
    this.systemService.getInfo(this.uri)
      .pipe(
        this.loadingService.lockUIUntilComplete()
      )
      .subscribe(info => {
        this.profileStorageKey = `axeos.poolProfiles.v1.${info.macAddr || this.uri || location.host}`;
        try {
          this.profiles = readPoolProfiles(localStorage.getItem(this.profileStorageKey));
        } catch {
          this.profiles = [];
        }
        this.form = this.fb.group({
          stratumURL: [info.stratumURL, [
            Validators.required,
            Validators.pattern(/^(?!.*stratum\+tcp:\/\/)(?!.*:[1-9]\d{0,4}$).*$/),
          ]],
          stratumPort: [info.stratumPort, [
            Validators.required,
            Validators.pattern(/^[^:]*$/),
            Validators.min(0),
            Validators.max(65535)
          ]],
          stratumExtranonceSubscribe: [info.stratumExtranonceSubscribe == true, [Validators.required]],
          stratumSuggestedDifficulty: [info.stratumSuggestedDifficulty, [Validators.required]],
          stratumUser: [info.stratumUser, [Validators.required]],
          stratumCoin: [info.stratumCoin ?? 0, [Validators.required, Validators.pattern(/^[0-3]$/)]],
          stratumPassword: ['*****', [Validators.required]],
          stratumTLS: [info.stratumTLS || 0],
          stratumCert: [info.stratumCert],
          stratumDecodeCoinbase: [info.stratumDecodeCoinbase == true, [Validators.required]],
          fallbackStratumURL: [info.fallbackStratumURL, [
            Validators.pattern(/^(?!.*stratum\+tcp:\/\/)(?!.*:[1-9]\d{0,4}$).*$/),
          ]],
          fallbackStratumPort: [info.fallbackStratumPort, [
            Validators.required,
            Validators.pattern(/^[^:]*$/),
            Validators.min(0),
            Validators.max(65535)
          ]],
          fallbackStratumExtranonceSubscribe: [info.fallbackStratumExtranonceSubscribe == true, [Validators.required]],
          fallbackStratumSuggestedDifficulty: [info.fallbackStratumSuggestedDifficulty, [Validators.required]],
          fallbackStratumTLS: [info.fallbackStratumTLS || 0],
          fallbackStratumCert: [info.fallbackStratumCert],
          fallbackStratumDecodeCoinbase: [info.fallbackStratumDecodeCoinbase == true, [Validators.required]],
          fallbackStratumUser: [info.fallbackStratumUser, [Validators.required]],
          fallbackStratumCoin: [info.fallbackStratumCoin ?? 0, [Validators.required, Validators.pattern(/^[0-3]$/)]],
          fallbackStratumPassword: ['*****', [Validators.required]]
        });

        const setupTlsValidation = (tlsControlName: string, certControlName: string) => {
          this.form.get(tlsControlName)?.valueChanges.subscribe(value => {
            const certControl = this.form.get(certControlName);
            if (value === 2) {
              certControl?.setValidators([
                Validators.required,
                this.pemCertificateValidator()
              ]);
            } else {
              certControl?.clearValidators();
            }
            certControl?.updateValueAndValidity();
          });
        };

        // Setup tls validation
        setupTlsValidation('stratumTLS', 'stratumCert');
        setupTlsValidation('fallbackStratumTLS', 'fallbackStratumCert');

        // Trigger initial validation
        this.form.get('stratumTLS')?.updateValueAndValidity();
        this.form.get('fallbackStratumTLS')?.updateValueAndValidity();
      });
  }

  public isZpool(pool: PoolType): boolean {
    return isZpoolSha256(this.form.get(pool + 'URL')?.value);
  }

  public useZpoolPreset(pool: PoolType): void {
    this.form.patchValue({
      [pool + 'URL']: 'sha256.eu.mine.zpool.ca',
      [pool + 'Port']: 53333,
      [pool + 'User']: '',
      [pool + 'Password']: 'c=BTC',
      [pool + 'Coin']: 0,
      [pool + 'TLS']: 1,
      [pool + 'Cert']: '',
      [pool + 'SuggestedDifficulty']: 0,
      [pool + 'ExtranonceSubscribe']: false,
      [pool + 'DecodeCoinbase']: false,
    });
    this.showPassword[pool] = false;
    this.form.get(pool + 'Password')?.markAsDirty();
    this.form.markAsDirty();
  }

  public saveProfile(pool: PoolType): void {
    const keys: (keyof PoolSettings)[] = [
      'URL', 'Port', 'User', 'Coin', 'TLS', 'Cert', 'SuggestedDifficulty', 'ExtranonceSubscribe', 'DecodeCoinbase'
    ];
    const settings = Object.fromEntries(keys.map(key => [key, this.form.get(pool + key)?.value]));
    const profile = poolProfile(this.profileNames[pool], settings);
    if (!profile || keys.some(key => this.form.get(pool + key)?.invalid)) {
      this.toastr.error('Enter a name and valid pool settings.');
      return;
    }
    if (this.profiles.some(saved => saved.name.toLowerCase() === profile.name.toLowerCase())) {
      this.toastr.error('A profile already uses that name.');
      return;
    }
    if (this.profiles.length >= PROFILE_LIMIT) {
      this.toastr.error('Remove a profile to make room for another.');
      return;
    }
    if (this.writeProfiles([...this.profiles, profile])) this.profileNames[pool] = '';
  }

  public loadProfile(pool: PoolType, name: string): void {
    const profile = this.profiles.find(saved => saved.name === name);
    if (!profile) return;
    this.form.patchValue(Object.fromEntries(Object.entries(profile.settings).map(([key, value]) => [pool + key, value])));
    // Require a fresh password so the previous pool's password cannot be reused by accident.
    const password = this.form.get(pool + 'Password');
    password?.setValue('');
    password?.markAsDirty();
    this.showPassword[pool] = false;
    this.form.markAsDirty();
  }

  public deleteProfile(name: string): void {
    if (this.writeProfiles(this.profiles.filter(profile => profile.name !== name))) {
      for (const pool of this.pools) {
        if (this.selectedProfiles[pool] === name) this.selectedProfiles[pool] = '';
      }
    }
  }

  private writeProfiles(profiles: PoolProfile[]): boolean {
    try {
      localStorage.setItem(this.profileStorageKey, JSON.stringify(profiles));
      this.profiles = profiles;
      return true;
    } catch {
      this.toastr.error('Pool profiles could not be saved in this browser.');
      return false;
    }
  }

  public updateSystem() {
    const form = this.form.getRawValue();

    if (form.stratumPassword === '*****') {
      delete form.stratumPassword;
    }
    if (form.fallbackStratumPassword === '*****') {
      delete form.fallbackStratumPassword;
    }

    this.systemService.updateSystem(this.uri, form)
      .pipe(this.loadingService.lockUIUntilComplete())
      .subscribe({
        next: () => {
          const successMessage = this.uri ? `Saved pool settings for ${this.uri}` : 'Saved pool settings';
          this.toastr.warning('You must restart this device after saving for changes to take effect.');
          this.toastr.success(successMessage);
          this.savedChanges = true;
        },
        error: (err: HttpErrorResponse) => {
          const errorMessage = this.uri ? `Could not save pool settings for ${this.uri}. ${err.message}` : `Could not save pool settings. ${err.message}`;
          this.toastr.error(errorMessage);
          this.savedChanges = false;
        }
      });
  }

  public restart() {
    this.systemService.restart(this.uri)
      .pipe(this.loadingService.lockUIUntilComplete())
      .subscribe({
        next: () => {
          const successMessage = this.uri ? `Device at ${this.uri} restarted` : 'Device restarted';
          this.toastr.success(successMessage);
        },
        error: (err: HttpErrorResponse) => {
          const errorMessage = this.uri ? `Failed to restart device at ${this.uri}. ${err.message}` : `Failed to restart device. ${err.message}`;
          this.toastr.error(errorMessage);
        }
      });
  }

  private extractPort(url: string): { cleanUrl: string, port?: number } {
    const match = url.match(/:(\d{1,5})$/);
    if (match) {
      const port = parseInt(match[1], 10);
      return { cleanUrl: url.slice(0, match.index), port };
    }
    return { cleanUrl: url };
  }

  public onUrlChange(poolType: PoolType) {
    const urlControl = this.form.get(`${poolType}URL`);
    const portControl = this.form.get(`${poolType}Port`);
    const tlsControl = this.form.get(`${poolType}TLS`);
    if (!urlControl || !portControl || !tlsControl) return;

    let urlValue = urlControl.value.trim() || '';

    if (!urlValue) return;

    const prefixes = [
      { prefix: 'stratum+tcp://', tlsMode: false },
      { prefix: 'stratum+tls://', tlsMode: true },
      { prefix: 'stratum+ssl://', tlsMode: true }
    ] as const;

    const matched = prefixes.find(({ prefix }) => urlValue.startsWith(prefix));
    if (matched) {
      urlValue = urlValue.slice(matched.prefix.length);
      tlsControl.setValue(Number(matched.tlsMode));
    }

    const { cleanUrl, port } = this.extractPort(urlValue);

    if (port !== undefined) {
      portControl.setValue(port);
    }
    urlControl.setValue(cleanUrl);
  }

  onCertFileSelected(event: Event, formControlName: string): void {
    const fileInput = event.target as HTMLInputElement;

    if (fileInput.files && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      const reader = new FileReader();

      reader.onload = () => {
        const fileContent = reader.result as string;
        // Update the corresponding certificate field in the form
        this.form.get(formControlName)?.setValue(fileContent);
        this.form.get(formControlName)?.markAsDirty();

        // Reset file input so the same file can be selected again
        fileInput.value = '';
      };

      reader.onerror = () => {
        // Error handling when reading the certificate file
        this.toastr.error('Failed to read certificate file');
        fileInput.value = '';
      };

      // Read the file as text
      reader.readAsText(file);
    }
  }

  private pemCertificateValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value?.trim();
      if (!value) return null;

      const pemChainRegex =
        /^(?:-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\s*)+$/;

      return pemChainRegex.test(value) ? null : { invalidCertificate: true };
    };
  }

  trackByFn(index: number, option: ITlsOption): number {
    return option.value;
  }

  isUsingDefaultAddress(pool: PoolType): boolean {
    const userValue = this.form?.get(pool + 'User')?.value || '';
    return userValue.includes(this.DEFAULT_BITCOIN_ADDRESS);
  }

  isAnyPoolUsingDefaultAddress(): boolean {
    return this.pools.some(pool => this.isUsingDefaultAddress(pool));
  }
}
