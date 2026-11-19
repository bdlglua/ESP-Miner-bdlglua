import { ChangeDetectionStrategy, Component, ElementRef } from '@angular/core';
import { LayoutService } from "./service/app.layout.service";

@Component({
  changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false,
  selector: 'app-sidebar',
    templateUrl: './app.sidebar.component.html'
})
export class AppSidebarComponent {
    constructor(public layoutService: LayoutService, public el: ElementRef) { }
}

