module Api
  module V1
    class MessagesController < BaseController
      before_action :require_channel_access!

      def create
        message = channel!.messages.create!(
          author: current_user, body: params.require(:body), parent_id: params[:parent_id]
        )
        Broadcast.message(message)
        render json: MessageSerializer.call(message), status: :created
      end
    end
  end
end
