module Api
  class MessagesController < BaseController
    def create
      channel!
      authorize_channel!
      return if performed?

      message = channel!.messages.create!(
        author: current_user, body: params.require(:body), parent_id: params[:parent_id]
      )
      Broadcast.message(message)
      render json: MessageSerializer.call(message), status: :created
    end
  end
end
