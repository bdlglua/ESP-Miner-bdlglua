import 'chartjs-adapter-moment';

import { CommonModule, HashLocationStrategy, LocationStrategy } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { NgModule, provideZoneChangeDetection } from '@angular/core';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { BrowserModule } from '@angular/platform-browser';
import { ToastrModule } from '@openng/ngx-toastr';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { ApiModule, Configuration } from './generated';
import { EditComponent } from './components/edit/edit.component';
import { PoolComponent } from './components/pool/pool.component';
import { NetworkEditComponent } from './components/network-edit/network.edit.component';
import { HomeComponent } from './components/home/home.component';
import { ModalComponent } from './components/modal/modal.component';
import { TooltipIconComponent } from './components/tooltip-icon/tooltip-icon.component';
import { TooltipTextIconComponent } from './components/tooltip-text-icon/tooltip-text-icon.component';
import { ConfettiComponent } from './components/confetti/confetti.component';
import { SnowflakesComponent } from './components/snowflakes/snowflakes.component';
import { LogsComponent } from './components/logs/logs.component';
import { SystemComponent } from './components/system/system.component';
import { UpdateComponent } from './components/update/update.component';
import { NetworkComponent } from './components/network/network.component';
import { SettingsComponent } from './components/settings/settings.component';
import { SwarmComponent } from './components/swarm/swarm.component';
import { ThemeConfigComponent } from './components/design/theme-config.component';
import { DesignComponent } from './components/design/design.component';
import { AppLayoutModule } from './layout/app.layout.module';
import { ANSIPipe } from './pipes/ansi.pipe';
import { DateAgoPipe } from './pipes/date-ago.pipe';
import { HashSuffixPipe } from './pipes/hash-suffix.pipe';
import { DiffSuffixPipe } from './pipes/diff-suffix.pipe';
import { AddressPipe } from './pipes/address.pipe';
import { SatsPipe } from './pipes/sats.pipe';
import { PrimeNGModule } from './prime-ng.module';
import { MessageModule } from '@openng/optimus-ui/message';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { DialogModule } from '@openng/optimus-ui/dialog';
import { DialogService as PrimeDialogService } from '@openng/optimus-ui/dynamicdialog';
import { provideOptimus } from '@openng/optimus-ui/config';
import Aura from '@openng/optimus-ui-themes/aura';
import { DialogService, DialogListComponent } from './services/dialog.service';

const components = [
  AppComponent,
  EditComponent,
  NetworkEditComponent,
  HomeComponent,
  ModalComponent,
  TooltipIconComponent,
  TooltipTextIconComponent,
  ConfettiComponent,
  SnowflakesComponent,
  NetworkComponent,
  SettingsComponent,
  LogsComponent,
  SystemComponent,
  UpdateComponent,
  PoolComponent
];

@NgModule({
  declarations: [
    ...components,

    ANSIPipe,
    DateAgoPipe,
    SwarmComponent,
    SettingsComponent,
    HashSuffixPipe,
    DiffSuffixPipe,
    AddressPipe,
    SatsPipe,
    ThemeConfigComponent,
    DesignComponent,
    PoolComponent,
    DialogListComponent
  ],
  imports: [
    BrowserModule,
    AppRoutingModule,
    ReactiveFormsModule,
    FormsModule,
    ToastrModule.forRoot({
      positionClass: 'toast-bottom-right'
    }),
    CommonModule,
    PrimeNGModule,
    AppLayoutModule,
    MessageModule,
    TooltipModule,
    DialogModule,
    ApiModule.forRoot(() => new Configuration({ basePath: '' }))
  ],
  providers: [
    // Existing components update plain fields from RxJS subscriptions.
    // Keep their pre-migration scheduling with Zone.js and explicit Eager checks.
    provideZoneChangeDetection(),
    { provide: LocationStrategy, useClass: HashLocationStrategy },
    DialogService,
    PrimeDialogService,
    provideHttpClient(),
    provideOptimus({ theme: { preset: Aura, options: { darkModeSelector: ".app-dark", cssLayer: false } } })
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
