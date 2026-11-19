import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LogsComponent } from './logs.component';
import { provideToastr } from '@openng/ngx-toastr';
import { ButtonModule } from '@openng/optimus-ui/button';
import { ReactiveFormsModule } from '@angular/forms';
import { TooltipModule } from '@openng/optimus-ui/tooltip';

describe('LogsComponent', () => {
  let component: LogsComponent;
  let fixture: ComponentFixture<LogsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [LogsComponent],
      imports: [ButtonModule, ReactiveFormsModule, TooltipModule],
      providers: [provideToastr()]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(LogsComponent);
    component = fixture.componentInstance;
    // JSDOM does not implement Element.scrollTo.
    component.stopScroll = true;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
