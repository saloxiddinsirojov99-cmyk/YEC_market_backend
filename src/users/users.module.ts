import { Module } from '@nestjs/common';
import { DefaultSuperAdminService } from './default-superadmin.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [UsersController, CustomersController],
  providers: [UsersService, CustomersService, DefaultSuperAdminService],
  exports: [UsersService, CustomersService],
})
export class UsersModule {}
