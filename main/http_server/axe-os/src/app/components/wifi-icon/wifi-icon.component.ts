import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
  selector: 'wifi-icon',
  templateUrl: './wifi-icon.component.html',
  styleUrls: ['./wifi-icon.component.scss'],
})
export class WifiIconComponent {
  @Input() rssi: number = 0;

  constructor() {}
}
