import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiConsumes } from '@nestjs/swagger';

export const FormDataRequest = () =>
  applyDecorators(
    ApiConsumes('multipart/form-data'),
    UseInterceptors(AnyFilesInterceptor()),
  );
