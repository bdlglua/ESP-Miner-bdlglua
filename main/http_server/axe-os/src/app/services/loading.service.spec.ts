import { TestBed } from '@angular/core/testing';

import { LoadingService } from './loading.service';
import { Observable, of, Subject, throwError } from 'rxjs';

describe('LoadingService', () => {
  let service: LoadingService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(LoadingService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('only shows loading while a synchronous source is subscribed', () => {
    const states: boolean[] = [];
    const values: string[] = [];
    const stateSubscription = service.loading$.subscribe(value => states.push(value));
    const operation = of('done').pipe(service.lockUIUntilComplete());
    expect(states).toEqual([false]);
    operation.subscribe(value => values.push(value));
    expect(values).toEqual(['done']);
    expect(states).toEqual([false, true, false]);
    stateSubscription.unsubscribe();
  });

  it('cancels the underlying source and clears loading when unsubscribed', () => {
    const cancel = vi.fn();
    const source = new Observable(() => cancel);
    const subscription = source.pipe(service.lockUIUntilComplete()).subscribe();
    expect(service.loading$.value).toBe(true);
    subscription.unsubscribe();
    subscription.unsubscribe();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(service.loading$.value).toBe(false);
  });

  it('forwards errors and releases the loading indicator', () => {
    const failure = new Error('offline');
    const onError = vi.fn();
    throwError(() => failure).pipe(service.lockUIUntilComplete()).subscribe({ error: onError });
    expect(onError).toHaveBeenCalledWith(failure);
    expect(service.loading$.value).toBe(false);
  });

  it('stays loading until all concurrent operations finish or are cancelled', () => {
    const first = new Subject<void>();
    const second = new Subject<void>();
    first.pipe(service.lockUIUntilComplete()).subscribe();
    const secondSubscription = second.pipe(service.lockUIUntilComplete()).subscribe();
    first.complete();
    expect(service.loading$.value).toBe(true);
    secondSubscription.unsubscribe();
    expect(service.loading$.value).toBe(false);
  });

  it('tracks separate subscriptions to the same operation', () => {
    const source = new Subject<void>();
    const operation = source.pipe(service.lockUIUntilComplete());
    const first = operation.subscribe();
    const second = operation.subscribe();
    first.unsubscribe();
    expect(service.loading$.value).toBe(true);
    second.unsubscribe();
    expect(service.loading$.value).toBe(false);
  });
});
