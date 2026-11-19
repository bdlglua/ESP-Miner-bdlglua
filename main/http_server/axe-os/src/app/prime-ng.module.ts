import { NgModule } from '@angular/core';
import { RadioButtonModule } from '@openng/optimus-ui/radiobutton';
import { ButtonModule } from '@openng/optimus-ui/button';
import { ChartModule } from '@openng/optimus-ui/chart';
import { CheckboxModule } from '@openng/optimus-ui/checkbox';
import { SelectModule } from '@openng/optimus-ui/select';
import { FileUploadModule } from '@openng/optimus-ui/fileupload';
import { InputGroupModule } from '@openng/optimus-ui/inputgroup';
import { InputGroupAddonModule } from '@openng/optimus-ui/inputgroupaddon';
import { InputTextModule } from '@openng/optimus-ui/inputtext';
import { DrawerModule } from '@openng/optimus-ui/drawer';
import { SliderModule } from '@openng/optimus-ui/slider';
import { TextareaModule } from '@openng/optimus-ui/textarea';
import { ProgressBarModule } from '@openng/optimus-ui/progressbar';

const primeNgModules = [
    DrawerModule,
    InputTextModule,
    CheckboxModule,
    SelectModule,
    SliderModule,
    ButtonModule,
    FileUploadModule,
    ChartModule,
    InputGroupModule,
    InputGroupAddonModule,
    RadioButtonModule,
    TextareaModule,
    ProgressBarModule,
];

@NgModule({
    imports: [
        ...primeNgModules
    ],
    exports: [
        ...primeNgModules
    ],
})
export class PrimeNGModule { }
