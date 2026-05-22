import { Request, Response } from 'express';
import logger from '../lib/logger';
import assistantConfigService from '../services/assistantConfig.service';
import phoneResolutionService from '../services/phoneResolution.service';
import callLoggingService from '../services/callLogging.service';

class VapiController {
  async handleAssistantConfig(req: Request, res: Response): Promise<void> {
    try {
      const phoneNumber = req.body?.message?.call?.to;

      logger.info(
        { action: 'assistant_config', phone_number: phoneNumber },
        'Assistant config request'
      );

      if (!phoneNumber) {
        res.status(400).json({ error: 'No phone number in request' });
        return;
      }

      const restaurant = await phoneResolutionService.resolvePhoneToRestaurant(phoneNumber);

      if (!restaurant) {
        logger.error(
          { action: 'assistant_config', phone_number: phoneNumber },
          'Restaurant not found for phone'
        );
        res.status(404).json({ error: 'Restaurant not found' });
        return;
      }

      const variableValues = assistantConfigService.buildVariableValues(restaurant);
      const config = assistantConfigService.buildAssistantConfig(variableValues);

      logger.info(
        { action: 'assistant_config_built', restaurant_id: restaurant.id },
        'Assistant config built successfully'
      );

      res.json(config);
    } catch (error: any) {
      logger.error(
        { action: 'assistant_config', error: error.message },
        'Assistant config error'
      );
      res.status(500).json({ error: 'Failed to build assistant config' });
    }
  }

  async handleCallStarted(event: any): Promise<void> {
    try {
      await callLoggingService.logCallStarted(event);
    } catch (err: any) {
      logger.error(
        { action: 'handle_call_started', error: err.message },
        'Failed to handle call.started event'
      );
    }
  }

  async handleCallEnded(event: any): Promise<void> {
    try {
      await callLoggingService.logCallEnded(event);
    } catch (err: any) {
      logger.error(
        { action: 'handle_call_ended', error: err.message },
        'Failed to handle call.ended event'
      );
    }
  }

  async resolveRestaurant(idOrSlug: string): Promise<string | null> {
    return phoneResolutionService.resolveRestaurantId(idOrSlug);
  }
}

export default new VapiController();
