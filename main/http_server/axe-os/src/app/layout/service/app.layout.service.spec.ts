import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { LayoutService } from './app.layout.service';
import { ThemeService, ThemeSettings } from '../../services/theme.service';

describe('LayoutService theme lifecycle', () => {
  let service: LayoutService;
  let settings: BehaviorSubject<ThemeSettings>;
  let activeSubscriptions: number;
  let totalSubscriptions: number;
  let previousStyle: string | null;
  let previousClass: string;

  beforeEach(() => {
    previousStyle = document.documentElement.getAttribute('style');
    previousClass = document.documentElement.className;
    settings = new BehaviorSubject<ThemeSettings>({
      colorScheme: 'dark', accentColors: { '--primary-color': '#123456' }
    });
    activeSubscriptions = totalSubscriptions = 0;
    const themeUpdates = new Observable<ThemeSettings>(subscriber => {
      activeSubscriptions++;
      totalSubscriptions++;
      const subscription = settings.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        activeSubscriptions--;
      };
    });
    TestBed.configureTestingModule({
      providers: [{ provide: ThemeService, useValue: {
        getThemeSettings: () => themeUpdates,
        saveThemeSettings: () => of(void 0)
      }}]
    });
    service = TestBed.inject(LayoutService);
    TestBed.tick();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    settings.complete();
    if (previousStyle === null) document.documentElement.removeAttribute('style');
    else document.documentElement.setAttribute('style', previousStyle);
    document.documentElement.className = previousClass;
  });

  it('keeps one subscription through repeated theme and layout changes', () => {
    for (let i = 0; i < 10; i++) {
      service.config.update(config => ({ ...config, scale: 14 + i }));
      settings.next({ colorScheme: i % 2 ? 'light' : 'dark',
        accentColors: { '--primary-color': '#abcdef' } });
      service.changeTheme();
      TestBed.tick();
    }
    expect(totalSubscriptions).toBe(1);
    expect(activeSubscriptions).toBe(1);
    expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('#abcdef');
    expect(service.config().scale).toBe(23);
  });

  it('preserves saved accent colors when only the color scheme changes', () => {
    settings.next({ colorScheme: 'light' });
    TestBed.tick();
    expect(service.config().colorScheme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('#123456');
    expect(document.documentElement.style.getPropertyValue('--surface-ground')).toBe('#243447');
    expect(totalSubscriptions).toBe(1);
  });

  it('releases its theme subscription when the application injector is destroyed', () => {
    TestBed.resetTestingModule();
    expect(activeSubscriptions).toBe(0);
    settings.next({ colorScheme: 'light', accentColors: { '--primary-color': '#ffffff' } });
    expect(document.documentElement.style.getPropertyValue('--primary-color')).toBe('#123456');
  });
});
