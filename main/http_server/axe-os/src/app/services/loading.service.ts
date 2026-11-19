import { Injectable } from '@angular/core';
import { BehaviorSubject, defer, finalize, Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class LoadingService {

  public loading$: BehaviorSubject<boolean> = new BehaviorSubject(false);
  private activeOperations = 0;

  constructor() { }

  public lockUIUntilComplete() {
    return <T>(source: Observable<T>): Observable<T> => {
      return defer(() => {
        this.activeOperations++;
        this.loading$.next(true);
        return source.pipe(finalize(() => {
          this.activeOperations--;
          this.loading$.next(this.activeOperations > 0);
        }));
      });
    }
  }
}
