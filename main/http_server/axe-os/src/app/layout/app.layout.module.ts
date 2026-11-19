import { HttpClientModule } from '@angular/common/http';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BrowserModule } from '@angular/platform-browser';
import { RouterModule } from '@angular/router';
import { BadgeModule } from '@openng/optimus-ui/badge';
import { ToggleSwitchModule } from '@openng/optimus-ui/toggleswitch';
import { InputTextModule } from '@openng/optimus-ui/inputtext';
import { RadioButtonModule } from '@openng/optimus-ui/radiobutton';
import { RippleModule } from '@openng/optimus-ui/ripple';
import { DrawerModule } from '@openng/optimus-ui/drawer';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { PrimeNGModule } from '../prime-ng.module';
import { AppFooterComponent } from './app.footer.component';
import { AppLayoutComponent } from './app.layout.component';
import { AppMenuComponent } from './app.menu.component';
import { AppMenuitemComponent } from './app.menuitem.component';
import { AppSidebarComponent } from './app.sidebar.component';
import { AppTopBarComponent } from './app.topbar.component';
import { LoadingComponent } from '../components/loading/loading.component';
import { WifiIconComponent } from '../components/wifi-icon/wifi-icon.component';

@NgModule({
    declarations: [
        AppMenuitemComponent,
        AppTopBarComponent,
        AppFooterComponent,
        AppMenuComponent,
        AppSidebarComponent,
        AppLayoutComponent,
        LoadingComponent,
        WifiIconComponent,
    ],
    imports: [
        BrowserModule,
        FormsModule,
        HttpClientModule,
        InputTextModule,
        DrawerModule,
        BadgeModule,
        RadioButtonModule,
        ToggleSwitchModule,
        RippleModule,
        RouterModule,
        PrimeNGModule,
        TooltipModule,
    ],
    exports: [AppLayoutComponent, WifiIconComponent]
})
export class AppLayoutModule { }
