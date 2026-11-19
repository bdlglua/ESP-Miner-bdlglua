import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
  selector: 'app-design',
  templateUrl: './design.component.html',
})
export class DesignComponent {
  constructor() { }
}
