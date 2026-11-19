import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  standalone: false,
  name: 'ANSI',
  pure: true
})
export class ANSIPipe implements PipeTransform {

  transform(value: string): string {
    return value.slice(9, value.length - 5);
  }

}
